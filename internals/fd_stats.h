#pragma once

#include <sys/resource.h>

#include <cstddef>

namespace spectator_nodejsmetrics
{

struct FileDescriptorStats
{
    size_t used;
    rlim_t max;
    bool max_is_unlimited;
};

FileDescriptorStats collectFileDescriptorStats();

}  // namespace spectator_nodejsmetrics
