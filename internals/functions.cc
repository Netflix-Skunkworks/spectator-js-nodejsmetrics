#include <nan.h>
#include <chrono>
#include <sys/resource.h>

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

class DetailedHeapStats {
 public:
  DetailedHeapStats()
      : isolate_(v8::Isolate::GetCurrent()),
        number_heap_spaces_(isolate_->NumberOfHeapSpaces()),
        heap_space_stats_(new v8::HeapSpaceStatistics[number_heap_spaces_]),
        collection_time_(0) {
    memset(heap_space_stats_, 0,
           sizeof(v8::HeapSpaceStatistics) * number_heap_spaces_);
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
    auto heap_spaces = Nan::New<v8::Array>(number_heap_spaces_);
    Nan::Set(obj, Nan::New("heapSpaceStats").ToLocalChecked(), heap_spaces);
    for (auto i = 0u; i < number_heap_spaces_; ++i) {
      auto h = Nan::New<Object>();
      serialize_heap_space(i, h);
      Nan::Set(heap_spaces, i, h);
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
    Nan::Set(obj, Nan::New("spaceName").ToLocalChecked(),
             Nan::New(space.space_name()).ToLocalChecked());
    Nan::Set(obj, Nan::New("spaceSize").ToLocalChecked(),
             Nan::New<Number>(space.space_size()));
    Nan::Set(obj, Nan::New("spaceUsedSize").ToLocalChecked(),
             Nan::New<Number>(space.space_used_size()));
    Nan::Set(obj, Nan::New("spaceAvailableSize").ToLocalChecked(),
             Nan::New<Number>(space.space_available_size()));
    Nan::Set(obj, Nan::New("physicalSpaceSize").ToLocalChecked(),
             Nan::New<Number>(space.physical_space_size()));
  }

  void serialize_heap_stats(Local<Object> obj) {
    Nan::Set(obj, Nan::New("totalHeapSize").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.total_heap_size()));
    Nan::Set(obj, Nan::New("totalHeapSizeExecutable").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.total_heap_size_executable()));
    Nan::Set(obj, Nan::New("totalPhysicalSize").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.total_physical_size()));
    Nan::Set(obj, Nan::New("totalAvailableSize").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.total_available_size()));
    Nan::Set(obj, Nan::New("usedHeapSize").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.used_heap_size()));
    Nan::Set(obj, Nan::New("heapSizeLimit").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.heap_size_limit()));
#if NODE_MODULE_VERSION >= NODE_7_0_MODULE_VERSION
    Nan::Set(obj, Nan::New("mallocedMemory").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.malloced_memory()));
    Nan::Set(obj, Nan::New("peakMallocedMemory").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.peak_malloced_memory()));
#endif
#if NODE_MODULE_VERSION >= NODE_10_0_MODULE_VERSION
    Nan::Set(obj, Nan::New("numNativeContexts").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.number_of_native_contexts()));
    Nan::Set(obj, Nan::New("numDetachedContexts").ToLocalChecked(),
             Nan::New<Number>(heap_stats_.number_of_detached_contexts()));
#endif
  }
};

DetailedHeapStats* before_stats;

class GCInfo {
 public:
  GCInfo(v8::GCType type, DetailedHeapStats* before)
      : type_{type}, before_{*before}, after_{} {
    after_.collect();
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
  Nan::HandleScope scope;
  auto* info = static_cast<GCInfo*>(handle->data);
  auto elapsed = info->elapsed();

  auto res = Nan::New<Object>();
  auto before = Nan::New<Object>();
  auto after = Nan::New<Object>();

  info->serialize(before, after);
  const char* typeStr = gcTypeToStr(info->type());

  Nan::Set(res, Nan::New("type").ToLocalChecked(),
           Nan::New(typeStr).ToLocalChecked());
  Nan::Set(res, Nan::New("elapsed").ToLocalChecked(),
           Nan::New<Number>(elapsed));
  Nan::Set(res, Nan::New("before").ToLocalChecked(), before);
  Nan::Set(res, Nan::New("after").ToLocalChecked(), after);

  Local<v8::Value> arguments[] = {res};
  Local<Function> callback = Nan::New(gcResource->callback);
  Local<Object> target = Nan::New<Object>();
  gcResource->runInAsyncScope(target, callback, 1, arguments);

  delete info;
  uv_close(reinterpret_cast<uv_handle_t*>(handle), close_callback);
}

// callback registered function with GC metrics
static NAN_GC_CALLBACK(afterGC) {
  auto* info = new GCInfo(type, before_stats);
  auto async = new uv_async_t;
  async->data = info;
  uv_async_init(uv_default_loop(), async, async_callback);
  uv_async_send(async);
}

NAN_METHOD(EmitGCEvents) {
  if (info.Length() != 1 || !info[0]->IsFunction()) {
    return Nan::ThrowError(
        "Expecting a function to be called after GC events.");
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

  auto res = Nan::New<Object>();
  auto used = get_dir_count("/proc/self/fd");
  Nan::Set(res, Nan::New("used").ToLocalChecked(), Nan::New<Number>(used));

  auto max = Nan::New("max").ToLocalChecked();
  struct rlimit rl;
  getrlimit(RLIMIT_NOFILE, &rl);
  if (rl.rlim_cur == RLIM_INFINITY) {
    Nan::Set(res, max, Nan::Null());
  } else {
    Nan::Set(res, max, Nan::New<Number>(rl.rlim_cur));
  }

  info.GetReturnValue().Set(res);
}

static NAN_GC_CALLBACK(beforeGC) { before_stats->collect(); }

NAN_MODULE_INIT(Init) {
  Nan::HandleScope scope;
  before_stats = new DetailedHeapStats;

  Nan::AddGCPrologueCallback(beforeGC);
  NAN_EXPORT(target, EmitGCEvents);
  NAN_EXPORT(target, GetCurMaxFd);
}

NODE_MODULE(spectator_internals, Init)
