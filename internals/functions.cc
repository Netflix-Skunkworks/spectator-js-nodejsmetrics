#include <nan.h>
#include <node.h>

#include "fd_stats.h"
#include "runtime_metrics_native.h"

using Nan::New;
using Nan::Set;

using v8::Function;
using v8::Local;
using v8::Number;
using v8::Object;

namespace
{

NAN_METHOD(EmitGCEvents)
{
    if (info.Length() != 1 || !info[0]->IsFunction())
    {
        return Nan::ThrowError("Expecting a function to be called after GC events.");
    }

    auto state = spectator_nodejsmetrics::currentAddonState(info.GetIsolate());
    if (!state || state->shuttingDown())
    {
        return Nan::ThrowError("nflx-spectator-nodejsmetrics addon is not initialized.");
    }

    state->addGcCallback(Nan::To<Function>(info[0]).ToLocalChecked());
}

NAN_METHOD(DisableGCEvents)
{
    if (info.Length() != 1 || !info[0]->IsFunction())
    {
        return Nan::ThrowError("Expecting a function to unregister from GC events.");
    }

    auto state = spectator_nodejsmetrics::currentAddonState(info.GetIsolate());
    if (!state || state->shuttingDown())
    {
        return;
    }

    state->removeGcCallback(Nan::To<Function>(info[0]).ToLocalChecked());
}

NAN_METHOD(GetCurMaxFd)
{
    Nan::HandleScope scope;

    const auto stats = spectator_nodejsmetrics::collectFileDescriptorStats();
    auto res = New<Object>();
    Set(res, New("used").ToLocalChecked(), New<Number>(stats.used));

    auto max = New("max").ToLocalChecked();
    if (stats.max_is_unlimited)
    {
        Set(res, max, Nan::Null());
    }
    else
    {
        Set(res, max, New<Number>(stats.max));
    }

    info.GetReturnValue().Set(res);
}

NAN_MODULE_INIT(Init)
{    
    Nan::HandleScope scope;

    auto* isolate = target->GetIsolate();
    spectator_nodejsmetrics::initializeAddonState(isolate, node::GetCurrentEventLoop(isolate));

    NAN_EXPORT(target, EmitGCEvents);
    NAN_EXPORT(target, DisableGCEvents);
    NAN_EXPORT(target, GetCurMaxFd);
}

}  // namespace

NAN_MODULE_WORKER_ENABLED(spectator_internals, Init)
