#include "runtime_metrics_native.h"

#include <nan.h>
#include <node.h>

#include <cstring>
#include <dirent.h>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace spectator_nodejsmetrics
{
namespace
{

std::mutex states_mutex;
std::unordered_map<v8::Isolate*, std::shared_ptr<AddonState>> states;

void beforeGC(v8::Isolate* isolate, v8::GCType type, v8::GCCallbackFlags flags, void* data)
{
    auto* state = static_cast<AddonState*>(data);
    if (state != nullptr)
    {
        state->collectBeforeGc();
    }
}

void afterGC(v8::Isolate* isolate, v8::GCType type, v8::GCCallbackFlags flags, void* data)
{
    auto* state = static_cast<AddonState*>(data);
    if (state != nullptr)
    {
        state->queueAfterGc(type);
    }
}

void cleanupAddonState(void* data)
{
    auto* state = static_cast<AddonState*>(data);
    if (state == nullptr)
    {
        return;
    }

    std::shared_ptr<AddonState> owned_state;
    {
        std::lock_guard<std::mutex> lock(states_mutex);
        auto entry = states.find(state->isolate());
        if (entry != states.end() && entry->second.get() == state)
        {
            owned_state = entry->second;
            states.erase(entry);
        }
    }

    if (owned_state)
    {
        owned_state->cleanup();
    }
    else
    {
        state->cleanup();
    }
}

size_t getDirCount(const char* dir)
{
    auto fd = opendir(dir);
    if (fd == nullptr)
    {
        return 0;
    }

    size_t count = 0;
    struct dirent* dp;
    while ((dp = readdir(fd)) != nullptr)
    {
        if (dp->d_name[0] == '.')
        {
            continue;
        }
        ++count;
    }

    closedir(fd);
    return count;
}

}  // namespace

class GCResource : public Nan::AsyncResource
{
   public:
    explicit GCResource(v8::Local<v8::Function> callback) : Nan::AsyncResource("spectator:GcCallback")
    {
        setCallback(callback);
    }

    ~GCResource() { callback_.Reset(); }

    void setCallback(v8::Local<v8::Function> callback) { callback_.Reset(callback); }

    bool matches(v8::Local<v8::Function> callback) const
    {
        return Nan::New(callback_)->StrictEquals(callback);
    }

    void call(v8::Local<v8::Value>* arguments, int argc)
    {
        v8::Local<v8::Function> callback = Nan::New(callback_);
        v8::Local<v8::Object> target = Nan::New<v8::Object>();
        runInAsyncScope(target, callback, argc, arguments);
    }

   private:
    Nan::Persistent<v8::Function> callback_;
};

class HeapSnapshot
{
   public:
    explicit HeapSnapshot(v8::Isolate* isolate)
        : isolate_(isolate),
          heap_space_stats_(isolate == nullptr ? 0 : isolate->NumberOfHeapSpaces()),
          collection_time_(0)
    {
        clear();
    }

    bool collect()
    {
        if (isolate_ == nullptr)
        {
            return false;
        }

        clear();
        collection_time_ = uv_hrtime();
        isolate_->GetHeapStatistics(&heap_stats_);

        bool ok = true;
        for (size_t i = 0; i < heap_space_stats_.size(); ++i)
        {
            if (!isolate_->GetHeapSpaceStatistics(&heap_space_stats_[i], i))
            {
                ok = false;
            }
        }
        return ok;
    }

    uint64_t collectionTime() const { return collection_time_; }

    void serialize(v8::Local<v8::Object> obj)
    {
        serializeHeapStats(obj);

        auto heap_spaces = Nan::New<v8::Array>(heap_space_stats_.size());
        Nan::Set(obj, Nan::New("heapSpaceStats").ToLocalChecked(), heap_spaces);

        for (size_t i = 0; i < heap_space_stats_.size(); ++i)
        {
            auto heap_space = Nan::New<v8::Object>();
            serializeHeapSpace(i, heap_space);
            Nan::Set(heap_spaces, static_cast<uint32_t>(i), heap_space);
        }
    }

   private:
    void clear()
    {
        std::memset(&heap_stats_, 0, sizeof(heap_stats_));
        if (!heap_space_stats_.empty())
        {
            std::memset(heap_space_stats_.data(), 0, heap_space_stats_.size() * sizeof(v8::HeapSpaceStatistics));
        }
    }

    void serializeHeapSpace(size_t space_idx, v8::Local<v8::Object> obj)
    {
        v8::HeapSpaceStatistics& space = heap_space_stats_[space_idx];
        Nan::Set(obj, Nan::New("spaceName").ToLocalChecked(), Nan::New(space.space_name()).ToLocalChecked());
        Nan::Set(obj, Nan::New("spaceSize").ToLocalChecked(), Nan::New<v8::Number>(space.space_size()));
        Nan::Set(obj, Nan::New("spaceUsedSize").ToLocalChecked(), Nan::New<v8::Number>(space.space_used_size()));
        Nan::Set(obj, Nan::New("spaceAvailableSize").ToLocalChecked(),
                 Nan::New<v8::Number>(space.space_available_size()));
        Nan::Set(obj, Nan::New("physicalSpaceSize").ToLocalChecked(),
                 Nan::New<v8::Number>(space.physical_space_size()));
    }

    void serializeHeapStats(v8::Local<v8::Object> obj)
    {
        Nan::Set(obj, Nan::New("totalHeapSize").ToLocalChecked(), Nan::New<v8::Number>(heap_stats_.total_heap_size()));
        Nan::Set(obj, Nan::New("totalHeapSizeExecutable").ToLocalChecked(),
                 Nan::New<v8::Number>(heap_stats_.total_heap_size_executable()));
        Nan::Set(obj, Nan::New("totalPhysicalSize").ToLocalChecked(),
                 Nan::New<v8::Number>(heap_stats_.total_physical_size()));
        Nan::Set(obj, Nan::New("totalAvailableSize").ToLocalChecked(),
                 Nan::New<v8::Number>(heap_stats_.total_available_size()));
        Nan::Set(obj, Nan::New("usedHeapSize").ToLocalChecked(), Nan::New<v8::Number>(heap_stats_.used_heap_size()));
        Nan::Set(obj, Nan::New("heapSizeLimit").ToLocalChecked(), Nan::New<v8::Number>(heap_stats_.heap_size_limit()));
#if NODE_MODULE_VERSION >= NODE_7_0_MODULE_VERSION
        Nan::Set(obj, Nan::New("mallocedMemory").ToLocalChecked(), Nan::New<v8::Number>(heap_stats_.malloced_memory()));
        Nan::Set(obj, Nan::New("peakMallocedMemory").ToLocalChecked(),
                 Nan::New<v8::Number>(heap_stats_.peak_malloced_memory()));
#endif
#if NODE_MODULE_VERSION >= NODE_10_0_MODULE_VERSION
        Nan::Set(obj, Nan::New("numNativeContexts").ToLocalChecked(),
                 Nan::New<v8::Number>(heap_stats_.number_of_native_contexts()));
        Nan::Set(obj, Nan::New("numDetachedContexts").ToLocalChecked(),
                 Nan::New<v8::Number>(heap_stats_.number_of_detached_contexts()));
#endif
    }

    v8::Isolate* isolate_;
    v8::HeapStatistics heap_stats_;
    std::vector<v8::HeapSpaceStatistics> heap_space_stats_;
    uint64_t collection_time_;
};

class GCEvent
{
   public:
    GCEvent(v8::Isolate* isolate, v8::GCType type, const HeapSnapshot& before)
        : type_(type), before_(before), after_(isolate)
    {
        after_.collect();
    }

    v8::GCType type() const { return type_; }

    double elapsed() const
    {
        if (after_.collectionTime() < before_.collectionTime())
        {
            return 0;
        }

        const auto elapsed_nanos = after_.collectionTime() - before_.collectionTime();
        return elapsed_nanos / 1e9;
    }

    void serialize(v8::Local<v8::Object> before, v8::Local<v8::Object> after)
    {
        before_.serialize(before);
        after_.serialize(after);
    }

   private:
    v8::GCType type_;
    HeapSnapshot before_;
    HeapSnapshot after_;
};

struct PendingGCEvent
{
    explicit PendingGCEvent(std::weak_ptr<AddonState> addon_state, GCEvent gc_event)
        : state(std::move(addon_state)), event(std::move(gc_event))
    {
        handle.data = this;
    }

    std::weak_ptr<AddonState> state;
    GCEvent event;
    uv_async_t handle;
};

std::shared_ptr<AddonState> AddonState::create(v8::Isolate* isolate, uv_loop_t* event_loop)
{
    return std::shared_ptr<AddonState>(new AddonState(isolate, event_loop));
}

AddonState::AddonState(v8::Isolate* isolate, uv_loop_t* event_loop)
    : isolate_(isolate), event_loop_(event_loop), before_stats_(std::make_unique<HeapSnapshot>(isolate))
{
}

AddonState::~AddonState() = default;

v8::Isolate* AddonState::isolate() const { return isolate_; }

bool AddonState::shuttingDown() const { return shutting_down_; }

void AddonState::registerPrologueCallback()
{
    if (!prologue_registered_)
    {
        isolate_->AddGCPrologueCallback(beforeGC, this);
        prologue_registered_ = true;
    }
}

void AddonState::addGcCallback(v8::Local<v8::Function> callback)
{
    if (shutting_down_)
    {
        return;
    }

    for (const auto& resource : gc_resources_)
    {
        if (resource->matches(callback))
        {
            return;
        }
    }

    gc_resources_.push_back(std::make_shared<GCResource>(callback));
    registerPrologueCallback();
    registerEpilogueCallback();
}

void AddonState::removeGcCallback(v8::Local<v8::Function> callback)
{
    for (auto it = gc_resources_.begin(); it != gc_resources_.end();)
    {
        if ((*it)->matches(callback))
        {
            it = gc_resources_.erase(it);
        }
        else
        {
            ++it;
        }
    }

    if (gc_resources_.empty())
    {
        unregisterEpilogueCallback();
        unregisterPrologueCallback();
    }
}

void AddonState::collectBeforeGc()
{
    if (!shutting_down_ && before_stats_)
    {
        before_stats_->collect();
    }
}

void AddonState::queueAfterGc(v8::GCType type)
{
    if (shutting_down_ || !before_stats_ || gc_resources_.empty())
    {
        return;
    }

    auto self = weak_from_this().lock();
    if (!self)
    {
        return;
    }

    auto* pending = new PendingGCEvent(self, GCEvent(isolate_, type, *before_stats_));
    const int init_result = uv_async_init(event_loop_, &pending->handle, asyncCallback);
    if (init_result != 0)
    {
        delete pending;
        return;
    }

    // Track the live handle so cleanup() can close any still-in-flight events at
    // isolate/environment teardown (e.g. a terminated worker) instead of orphaning them.
    pending_events_.insert(pending);

    const int send_result = uv_async_send(&pending->handle);
    if (send_result != 0)
    {
        pending_events_.erase(pending);
        uv_close(reinterpret_cast<uv_handle_t*>(&pending->handle), closeAsyncHandle);
    }
}

void AddonState::emitGcEvent(GCEvent& event)
{
    if (shutting_down_ || gc_resources_.empty())
    {
        return;
    }

    Nan::HandleScope scope;
    auto gc_resources = gc_resources_;

    for (const auto& resource : gc_resources)
    {
        auto res = Nan::New<v8::Object>();
        auto before = Nan::New<v8::Object>();
        auto after = Nan::New<v8::Object>();

        event.serialize(before, after);

        Nan::Set(res, Nan::New("type").ToLocalChecked(), Nan::New(gcTypeToStr(event.type())).ToLocalChecked());
        Nan::Set(res, Nan::New("elapsed").ToLocalChecked(), Nan::New<v8::Number>(event.elapsed()));
        Nan::Set(res, Nan::New("before").ToLocalChecked(), before);
        Nan::Set(res, Nan::New("after").ToLocalChecked(), after);

        v8::Local<v8::Value> arguments[] = {res};

        // Contain a throwing listener so it can neither abort the fan-out to the other
        // listeners nor escalate to a process-level uncaughtException from this GC callback.
        Nan::TryCatch try_catch;
        resource->call(arguments, 1);
    }
}

void AddonState::cleanup()
{
    if (shutting_down_)
    {
        return;
    }

    shutting_down_ = true;
    unregisterEpilogueCallback();
    unregisterPrologueCallback();
    gc_resources_.clear();
    before_stats_.reset();

    // Close any GC events still in flight so libuv can drain and free them during teardown,
    // rather than leaving open handles on a loop that is about to close. Deletion happens in
    // closeAsyncHandle when each close callback fires; it does not touch pending_events_.
    for (auto* pending : pending_events_)
    {
        uv_close(reinterpret_cast<uv_handle_t*>(&pending->handle), closeAsyncHandle);
    }
    pending_events_.clear();
}

const char* AddonState::gcTypeToStr(v8::GCType type)
{
    switch (type)
    {
        case v8::kGCTypeScavenge:
            return "scavenge";
        case v8::kGCTypeMarkSweepCompact:
            return "markSweepCompact";
        case v8::kGCTypeIncrementalMarking:
            return "incrementalMarking";
        case v8::kGCTypeProcessWeakCallbacks:
            return "processWeakCallbacks";
        default:
            return "unknown";
    }
}

void AddonState::asyncCallback(uv_async_t* handle)
{
    auto* pending = static_cast<PendingGCEvent*>(handle->data);
    auto state = pending->state.lock();
    if (state)
    {
        state->emitGcEvent(pending->event);
        // Stop tracking this handle before we close it; cleanup() must not double-close it.
        state->pending_events_.erase(pending);
    }
    uv_close(reinterpret_cast<uv_handle_t*>(handle), closeAsyncHandle);
}

void AddonState::closeAsyncHandle(uv_handle_t* handle) { delete static_cast<PendingGCEvent*>(handle->data); }

void AddonState::registerEpilogueCallback()
{
    if (!epilogue_registered_)
    {
        isolate_->AddGCEpilogueCallback(afterGC, this);
        epilogue_registered_ = true;
    }
}

void AddonState::unregisterPrologueCallback()
{
    if (prologue_registered_)
    {
        isolate_->RemoveGCPrologueCallback(beforeGC, this);
        prologue_registered_ = false;
    }
}

void AddonState::unregisterEpilogueCallback()
{
    if (epilogue_registered_)
    {
        isolate_->RemoveGCEpilogueCallback(afterGC, this);
        epilogue_registered_ = false;
    }
}

std::shared_ptr<AddonState> currentAddonState(v8::Isolate* isolate)
{
    std::lock_guard<std::mutex> lock(states_mutex);
    auto state = states.find(isolate);
    if (state == states.end())
    {
        return nullptr;
    }
    return state->second;
}

std::shared_ptr<AddonState> initializeAddonState(v8::Isolate* isolate, uv_loop_t* event_loop)
{
    std::shared_ptr<AddonState> state;
    bool new_state = false;
    {
        std::lock_guard<std::mutex> lock(states_mutex);
        auto entry = states.find(isolate);
        if (entry == states.end())
        {
            state = AddonState::create(isolate, event_loop);
            states[isolate] = state;
            new_state = true;
        }
        else
        {
            state = entry->second;
        }
    }

    if (new_state)
    {
        node::AddEnvironmentCleanupHook(isolate, cleanupAddonState, state.get());
    }

    return state;
}

FileDescriptorStats collectFileDescriptorStats()
{
    struct rlimit rl;
    getrlimit(RLIMIT_NOFILE, &rl);

    return FileDescriptorStats{
        getDirCount("/proc/self/fd"),
        rl.rlim_cur,
        rl.rlim_cur == RLIM_INFINITY,
    };
}

}  // namespace spectator_nodejsmetrics
