#include "runtime_metrics_native.h"

#include <nan.h>
#include <node.h>

#include <mutex>
#include <unordered_map>
#include <vector>

#include "heap_snapshot.h"

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

}  // namespace spectator_nodejsmetrics
