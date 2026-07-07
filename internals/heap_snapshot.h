#pragma once

#include <v8.h>

#include <cstddef>
#include <cstdint>
#include <vector>

namespace spectator_nodejsmetrics
{

// A point-in-time capture of V8 heap and per-space statistics for one isolate,
// with helpers to serialize the snapshot into a JS object.
class HeapSnapshot
{
   public:
    explicit HeapSnapshot(v8::Isolate* isolate);

    bool collect();
    uint64_t collectionTime() const { return collection_time_; }
    void serialize(v8::Local<v8::Object> obj);

   private:
    void clear();
    void serializeHeapSpace(size_t space_idx, v8::Local<v8::Object> obj);
    void serializeHeapStats(v8::Local<v8::Object> obj);

    v8::Isolate* isolate_;
    v8::HeapStatistics heap_stats_;
    std::vector<v8::HeapSpaceStatistics> heap_space_stats_;
    uint64_t collection_time_;
};

// A single GC occurrence: the "before" snapshot captured in the GC prologue paired
// with an "after" snapshot captured at construction time (in the GC epilogue).
class GCEvent
{
   public:
    GCEvent(v8::Isolate* isolate, v8::GCType type, const HeapSnapshot& before);

    v8::GCType type() const { return type_; }
    double elapsed() const;
    void serialize(v8::Local<v8::Object> before, v8::Local<v8::Object> after);

   private:
    v8::GCType type_;
    HeapSnapshot before_;
    HeapSnapshot after_;
};

}  // namespace spectator_nodejsmetrics
