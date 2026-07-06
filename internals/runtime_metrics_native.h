#pragma once

#include <uv.h>
#include <v8.h>

#include <memory>
#include <sys/resource.h>
#include <unordered_set>
#include <vector>

namespace spectator_nodejsmetrics
{

class GCResource;
class GCEvent;
class HeapSnapshot;
struct PendingGCEvent;

struct FileDescriptorStats
{
    size_t used;
    rlim_t max;
    bool max_is_unlimited;
};

class AddonState : public std::enable_shared_from_this<AddonState>
{
   public:
    static std::shared_ptr<AddonState> create(v8::Isolate* isolate, uv_loop_t* event_loop);
    ~AddonState();

    v8::Isolate* isolate() const;
    bool shuttingDown() const;

    void registerPrologueCallback();
    void addGcCallback(v8::Local<v8::Function> callback);
    void removeGcCallback(v8::Local<v8::Function> callback);
    void collectBeforeGc();
    void queueAfterGc(v8::GCType type);
    void cleanup();

   private:
    explicit AddonState(v8::Isolate* isolate, uv_loop_t* event_loop);

    void emitGcEvent(GCEvent& event);
    static const char* gcTypeToStr(v8::GCType type);
    static void asyncCallback(uv_async_t* handle);
    static void closeAsyncHandle(uv_handle_t* handle);

    void registerEpilogueCallback();
    void unregisterPrologueCallback();
    void unregisterEpilogueCallback();

    v8::Isolate* isolate_;
    uv_loop_t* event_loop_;
    std::unique_ptr<HeapSnapshot> before_stats_;
    std::vector<std::shared_ptr<GCResource>> gc_resources_;
    std::unordered_set<PendingGCEvent*> pending_events_;
    bool shutting_down_ = false;
    bool prologue_registered_ = false;
    bool epilogue_registered_ = false;
};

std::shared_ptr<AddonState> currentAddonState(v8::Isolate* isolate);
std::shared_ptr<AddonState> initializeAddonState(v8::Isolate* isolate, uv_loop_t* event_loop);
FileDescriptorStats collectFileDescriptorStats();

}  // namespace spectator_nodejsmetrics
