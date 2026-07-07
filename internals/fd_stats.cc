#include "fd_stats.h"

#include <dirent.h>

namespace spectator_nodejsmetrics
{
namespace
{

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
