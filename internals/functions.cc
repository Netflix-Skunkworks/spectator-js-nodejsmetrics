#include <nan.h>
#include <chrono>
#include <sys/resource.h>
#include <node.h>

using Nan::Set;
using Nan::New;

using v8::Function;
using v8::Local;
using v8::Number;
using v8::Object;

class GCResource : public Nan::AsyncResource {
 public:
  explicit GCResource(Local<Function> cb)
      : Nan::AsyncResource("spectator:GcCallback") {
    callback.Reset(cb);
  }

  Nan::Persistent<Function> callback;
};

static GCResource* gcResource;
static bool isolate_shutting_down;

class DetailedHeapStats {
 public:
  DetailedHeapStats()
      : isolate_(v8::Isolate::GetCurrent()),
        number_heap_spaces_(isolate_->NumberOfHeapSpaces()),
        heap_space_stats_(new v8::HeapSpaceStatistics[number_heap_spaces_]),
        collection_time_(0) {
    memset(heap_space_stats_, 0, sizeof(v8::HeapSpaceStatistics) * number_heap_spaces_);
  }

  DetailedHeapStats(const DetailedHeapStats& other) {
    isolate_ = other.isolate_;
    number_heap_spaces_ = other.number_heap_spaces_;
    heap_space_stats_ = new v8::HeapSpaceStatistics[number_heap_spaces_];
    memcpy(heap_space_stats_, other.heap_space_stats_, number_heap_spaces_ * sizeof(v8::HeapSpaceStatistics));
    collection_time_ = other.collection_time_;
  }

  ~DetailedHeapStats() { delete[] heap_space_stats_; }

  bool collect() {
    if (isolate_shutting_down) return false;

    collection_time_ = uv_hrtime();
    Nan::GetHeapStatistics(&heap_stats_);
    auto ok = true;
    for (auto i = 0u; i < number_heap_spaces_; ++i) {
      if (!isolate_->GetHeapSpaceStatistics(&heap_space_stats_[i], i)) {
        ok = false;
      }
    }
    return ok;
  }

  uint64_t collection_time() const { return collection_time_; }

  void serialize(Local<Object> obj) {
    serialize_heap_stats(obj);
    auto heap_spaces = New<v8::Array>(number_heap_spaces_);
    Set(obj, New("heapSpaceStats").ToLocalChecked(), heap_spaces);
    for (auto i = 0u; i < number_heap_spaces_; ++i) {
      auto h = New<Object>();
      serialize_heap_space(i, h);
      Set(heap_spaces, i, h);
    }
  }

 private:
  v8::Isolate* isolate_;
  size_t number_heap_spaces_;
  v8::HeapStatistics heap_stats_;
  v8::HeapSpaceStatistics* heap_space_stats_;
  uint64_t collection_time_;

  void serialize_heap_space(size_t space_idx, Local<Object> obj) {
    v8::HeapSpaceStatistics& space = heap_space_stats_[space_idx];
    Set(obj, New("spaceName").ToLocalChecked(), New(space.space_name()).ToLocalChecked());
    Set(obj, New("spaceSize").ToLocalChecked(), New<Number>(space.space_size()));
    Set(obj, New("spaceUsedSize").ToLocalChecked(), New<Number>(space.space_used_size()));
    Set(obj, New("spaceAvailableSize").ToLocalChecked(), New<Number>(space.space_available_size()));
    Set(obj, New("physicalSpaceSize").ToLocalChecked(), New<Number>(space.physical_space_size()));
  }

  void serialize_heap_stats(Local<Object> obj) {
    Set(obj, New("totalHeapSize").ToLocalChecked(), New<Number>(heap_stats_.total_heap_size()));
    Set(obj, New("totalHeapSizeExecutable").ToLocalChecked(), New<Number>(heap_stats_.total_heap_size_executable()));
    Set(obj, New("totalPhysicalSize").ToLocalChecked(), New<Number>(heap_stats_.total_physical_size()));
    Set(obj, New("totalAvailableSize").ToLocalChecked(), New<Number>(heap_stats_.total_available_size()));
    Set(obj, New("usedHeapSize").ToLocalChecked(), New<Number>(heap_stats_.used_heap_size()));
    Set(obj, New("heapSizeLimit").ToLocalChecked(), New<Number>(heap_stats_.heap_size_limit()));
#if NODE_MODULE_VERSION >= NODE_7_0_MODULE_VERSION
    Set(obj, New("mallocedMemory").ToLocalChecked(), New<Number>(heap_stats_.malloced_memory()));
    Set(obj, New("peakMallocedMemory").ToLocalChecked(), New<Number>(heap_stats_.peak_malloced_memory()));
#endif
#if NODE_MODULE_VERSION >= NODE_10_0_MODULE_VERSION
    Set(obj, New("numNativeContexts").ToLocalChecked(), New<Number>(heap_stats_.number_of_native_contexts()));
    Set(obj, New("numDetachedContexts").ToLocalChecked(), New<Number>(heap_stats_.number_of_detached_contexts()));
#endif
  }
};

DetailedHeapStats* before_stats;

class GCInfo {
 public:
  GCInfo(v8::GCType type, DetailedHeapStats* before)
      : type_{type}, before_{*before}, after_{} {
    if (!isolate_shutting_down) {
      after_.collect();
    }
  }

  v8::GCType type() const { return type_; }

  double elapsed() const {
    if (after_.collection_time() < before_.collection_time()) {
      return 0;
    }

    auto elapsedNanos = after_.collection_time() - before_.collection_time();
    return elapsedNanos / 1e9;
  }

  void serialize(Local<Object> before, Local<Object> after) {
    before_.serialize(before);
    after_.serialize(after);
  }

 private:
  v8::GCType type_;
  DetailedHeapStats before_;
  DetailedHeapStats after_;
};

static void close_callback(uv_handle_t* handle) { delete handle; }

static const char* gcTypeToStr(v8::GCType type) {
  switch (type) {
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

static void async_callback(uv_async_t* handle) {
  auto* info = static_cast<GCInfo*>(handle->data);

  if (isolate_shutting_down || !gcResource) {
    delete info;
    uv_close(reinterpret_cast<uv_handle_t*>(handle), close_callback);
    return;
  }

  Nan::HandleScope scope;
  auto elapsed = info->elapsed();

  auto res = New<Object>();
  auto before = New<Object>();
  auto after = New<Object>();

  info->serialize(before, after);
  const char* typeStr = gcTypeToStr(info->type());

  Set(res, New("type").ToLocalChecked(), New(typeStr).ToLocalChecked());
  Set(res, New("elapsed").ToLocalChecked(), New<Number>(elapsed));
  Set(res, New("before").ToLocalChecked(), before);
  Set(res, New("after").ToLocalChecked(), after);

  Local<v8::Value> arguments[] = {res};
  Local<Function> callback = New(gcResource->callback);
  Local<Object> target = New<Object>();
  gcResource->runInAsyncScope(target, callback, 1, arguments);

  delete info;
  uv_close(reinterpret_cast<uv_handle_t*>(handle), close_callback);
}

// callback registered function with GC metrics
static NAN_GC_CALLBACK(afterGC) {
  if (isolate_shutting_down || !before_stats) {
    return;
  }
  auto* info = new GCInfo(type, before_stats);
  auto async = new uv_async_t;
  async->data = info;
  uv_async_init(uv_default_loop(), async, async_callback);
  uv_async_send(async);
}

NAN_METHOD(EmitGCEvents) {
  if (info.Length() != 1 || !info[0]->IsFunction()) {
    return Nan::ThrowError("Expecting a function to be called after GC events.");
  }

  auto callback = Nan::To<Function>(info[0]).ToLocalChecked();
  gcResource = new GCResource(callback);
  Nan::AddGCEpilogueCallback(afterGC);
}

static size_t get_dir_count(const char* dir) {
  auto fd = opendir(dir);
  if (fd == nullptr) {
    return 0;
  }
  size_t count = 0;
  struct dirent* dp;
  while ((dp = readdir(fd)) != nullptr) {
    if (dp->d_name[0] == '.') {
      // ignore hidden files (including . and ..)
      continue;
    }
    ++count;
  }
  closedir(fd);
  return count;
}

NAN_METHOD(GetCurMaxFd) {
  Nan::HandleScope scope;

  auto res = New<Object>();
  auto used = get_dir_count("/proc/self/fd");
  Set(res, New("used").ToLocalChecked(), New<Number>(used));

  auto max = New("max").ToLocalChecked();
  struct rlimit rl;
  getrlimit(RLIMIT_NOFILE, &rl);
  if (rl.rlim_cur == RLIM_INFINITY) {
    Set(res, max, Nan::Null());
  } else {
    Set(res, max, New<Number>(rl.rlim_cur));
  }

  info.GetReturnValue().Set(res);
}

static NAN_GC_CALLBACK(beforeGC) {
  if (!isolate_shutting_down) {
    before_stats->collect();
  }
}

static void cleanup(void* arg) {
  isolate_shutting_down = true;
  Nan::RemoveGCPrologueCallback(beforeGC);
  Nan::RemoveGCEpilogueCallback(afterGC);
  delete before_stats;
  before_stats = nullptr;
  delete gcResource;
  gcResource = nullptr;
}

NAN_MODULE_INIT(Init) {
  Nan::HandleScope scope;
  
  // Initialize global state
  isolate_shutting_down = false;
  before_stats = new DetailedHeapStats;
  gcResource = nullptr;

  node::AtExit(node::GetCurrentEnvironment(Nan::GetCurrentContext()), cleanup, nullptr);
  Nan::AddGCPrologueCallback(beforeGC);
  NAN_EXPORT(target, EmitGCEvents);
  NAN_EXPORT(target, GetCurMaxFd);
}

NODE_MODULE(spectator_internals, Init)
