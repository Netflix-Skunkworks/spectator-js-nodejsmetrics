[![Build Status](https://travis-ci.com/Netflix-Skunkworks/spectator-js-nodejsmetrics.svg?branch=master)](https://travis-ci.com/Netflix-Skunkworks/spectator-js-nodejsmetrics) 
[![codecov](https://codecov.io/gh/Netflix-Skunkworks/spectator-js-nodejsmetrics/branch/master/graph/badge.svg)](https://codecov.io/gh/Netflix-Skunkworks/spectator-js-nodejsmetrics)

# Introduction

> :warning: Experimental

Generate Node.js internal metrics using the [nflx-spectator] Node module.

[nflx-spectator]: https://github.com/Netflix/spectator-js

# Usage Example

```javascript
'use strict';

function getConfig() {
}

const spectator = require('nflx-spectator');
const NodeMetrics = require('nflx-spectator-nodejsmetrics');

const config = {
  commonTags: {'nf.node': 'i-1234'},
  uri: 'http://atlas.example.org/v1/publish'
};
const registry = new spectator.Registry(config);
registry.start();

const metrics = new NodeMetrics(registry);
metrics.start(); // start collecting nodejs metrics

// ...

metrics.stop();
registry.stop();
```

# Metrics Glossary

## Common Dimensions

The following dimensions are common to the metrics published by this module:

* `nodejs.version`: The version of the Node.js runtime.

## CPU Metrics

### nodejs.cpuUsage

Percentage of CPU time the Node.js process is consuming, from 0..100.

The usage is divided into the following categories:

* `system`: CPU time spent running the kernel.
* `user`: CPU time spent running user space (non-kernel) processes.

**Unit:** percent

**Dimensions:**

* `id`: The category of CPU usage.

Example:

```js
{
  "tags": {
    "id": "system",
    "name": "nodejs.cpuUsage",
    /// nf.* tags
    "nodejs.version": "v6.5.0"
  },
  "start": 1485813720000,
  "value": 0.8954088417692685
},
{
  "tags": {
    "id": "user",
    "name": "nodejs.cpuUsage",
    /// nf.* tags
    "nodejs.version": "v6.5.0"
  },
  "start": 1485813720000,
  "value": 4.659007745141895
}
```

## Event Loop Metrics

### nodejs.eventLoop

The time it takes for the event loop to complete. This is sampled twice per second.

**Unit:** seconds

### nodejs.eventLoopLag

The time that the event loop is running behind, as measured by attempting to execute
a timer once per second.

**Unit:** seconds

## Garbage Collection Metrics

### nodejs.gc.allocationRate

The rate at which the app is allocating memory.

**Unit:** bytes/second

### nodejs.gc.liveDataSize

The size of the `old_space` after a major GC event.

**Unit:** bytes

### nodejs.gc.maxDataSize

The maximum amount of memory the nodejs process is allowed to use.  This is primarily used
for gaining perspective on the `liveDataSize`.

**Unit:** bytes

### nodejs.gc.pause

The time it takes to complete different GC events.

Event categories:

* `scavenge`: The most common garbage collection method. Node will typically trigger one of
these every time the VM is idle.
* `markSweepCompact`: The heaviest type of garbage collection V8 may do. If you see many of
these happening you will need to either keep fewer objects around in your process or increase
V8's heap limit.
* `incrementalMarking`: A phased garbage collection that interleaves collection with application
logic to reduce the amount of time the application is paused.
* `processWeakCallbacks`: After a garbage collection occurs, V8 will call any weak reference
callbacks registered for objects that have been freed. This measurement is from the start of
the first weak callback to the end of the last for a given garbage collection.

**Unit:** seconds

**Dimensions:**

* `id`: The GC event category.

### nodejs.gc.promotionRate

The rate at which data is being moved from `new_space` to `old_space`.

**Unit:** bytes/second

## Memory Usage Metrics

### nodejs.rss

Resident Set Size, which is the total memory allocated for the process execution. This includes
the Code Segment, Stack (local variables and pointers) and Heap (objects and closures).

**Unit:** bytes

### nodejs.heapTotal

Total size of the allocated heap.

**Unit:** bytes

### nodejs.heapUsed

Memory used during the execution of our process.

**Unit:** bytes

### nodejs.external

Memory usage of C++ objects bound to JavaScript objects managed by V8.

**Unit:** bytes

## V8 Heap Statistics Metrics

Data is gathered from the [v8.getHeapStatistics] method.

[v8.getHeapStatistics]: https://nodejs.org/api/v8.html#v8_v8_getheapstatistics

### nodejs.doesZapGarbage

Whether or not the `--zap_code_space` option is enabled.

This makes V8 overwrite heap garbage with a bit pattern. The RSS footprint (resident memory set)
gets bigger because it continuously touches all heap pages and that makes them less likely to get
swapped out by the operating system.

**Unit:** boolean

### nodejs.heapSizeLimit

The absolute limit the heap cannot exceed (default limit or `--max_old_space_size`).

**Unit:** bytes

### nodejs.mallocedMemory

Current amount of memory, obtained via `malloc`.

**Unit:** bytes

### nodejs.peakMallocedMemory

Peak amount of memory, obtained via `malloc`.

**Unit:** bytes

### nodejs.totalAvailableSize

Available heap size.

**Unit:** bytes

### nodejs.totalHeapSize

Memory V8 has allocated for the heap. This can grow if `usedHeap` needs more.

**Unit:** bytes

### nodejs.totalHeapSizeExecutable

Memory for compiled bytecode and JITed code.

**Unit:** bytes

### nodejs.totalPhysicalSize

Committed size.

**Unit:** bytes

### nodejs.usedHeapSize

Memory used by application data.

**Unit:** bytes

## V8 Heap Space Statistics Metrics

Data is gathered from the [v8.getHeapSpaceStatistics] method, for each space listed.

Space categories:

* `new_space`: Where new allocations happen; it is fast to allocate and collect garbage here.
Objects living in the New Space are called the Young Generation. 
* `old_space`: Object that survived the New Space collector are promoted here; they are called
the Old Generation. Allocation in the Old Space is fast, but collection is expensive so it is
less frequently performed.
* `code_space`: Contains executable code and therefore is marked executable.
* `map_space`: Contains map objects only.
* `large_object_space`: Contains promoted large objects which exceed the size limits of other
spaces. Each object gets its own `mmap` region of memory and these objects are never moved by GC.

[v8.getHeapSpaceStatistics]: https://nodejs.org/api/v8.html#v8_v8_getheapspacestatistics

### nodejs.spaceSize

The allocated size of the space.

**Unit:** bytes

**Dimensions:**

* `id`: Space category.

### nodejs.spaceUsedSize

The used size of the space.

**Unit:** bytes

**Dimensions:**

* `id`: Space category.

### nodejs.spaceAvailableSize

The available size of the space.

**Unit:** bytes

**Dimensions:**

* `id`: Space category.

### nodejs.physicalSpaceSize

The physical size of the space.

**Unit:** bytes

**Dimensions:**

* `id`: Space category.

## File Descriptor Metrics

### openFileDescriptorsCount

Number of file descriptors currently open.

**Unit:** file descriptors

### maxFileDescriptorsCount

The maximum number of file descriptors that can be open at the same time.

**Unit:** file descriptors
