#include "heap_snapshot.h"

#include <nan.h>
#include <uv.h>

#include <cstring>

namespace spectator_nodejsmetrics
{

HeapSnapshot::HeapSnapshot(v8::Isolate* isolate)
    : isolate_(isolate),
      heap_space_stats_(isolate == nullptr ? 0 : isolate->NumberOfHeapSpaces()),
      collection_time_(0)
{
    clear();
}

bool HeapSnapshot::collect()
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

void HeapSnapshot::serialize(v8::Local<v8::Object> obj)
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

void HeapSnapshot::clear()
{
    std::memset(&heap_stats_, 0, sizeof(heap_stats_));
    if (!heap_space_stats_.empty())
    {
        std::memset(heap_space_stats_.data(), 0, heap_space_stats_.size() * sizeof(v8::HeapSpaceStatistics));
    }
}

void HeapSnapshot::serializeHeapSpace(size_t space_idx, v8::Local<v8::Object> obj)
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

void HeapSnapshot::serializeHeapStats(v8::Local<v8::Object> obj)
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

GCEvent::GCEvent(v8::Isolate* isolate, v8::GCType type, const HeapSnapshot& before)
    : type_(type), before_(before), after_(isolate)
{
    after_.collect();
}

double GCEvent::elapsed() const
{
    if (after_.collectionTime() < before_.collectionTime())
    {
        return 0;
    }

    const auto elapsed_nanos = after_.collectionTime() - before_.collectionTime();
    return elapsed_nanos / 1e9;
}

void GCEvent::serialize(v8::Local<v8::Object> before, v8::Local<v8::Object> after)
{
    before_.serialize(before);
    after_.serialize(after);
}

}  // namespace spectator_nodejsmetrics
