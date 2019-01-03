[![Build Status](https://travis-ci.org/Netflix-Skunkworks/spectator-js-nodejsmetrics.svg?branch=master)](https://travis-ci.org/Netflix-Skunkworks/spectator-js-nodejsmetrics) 
[![codecov](https://codecov.io/gh/Netflix-Skunkworks/spectator-js-nodejsmetrics/branch/master/graph/badge.svg)](https://codecov.io/gh/Netflix-Skunkworks/spectator-js-nodejsmetrics)

# Spectator-js node.js metrics

> :warning: Experimental

Generate node.js internal metrics using the
[nflx-spectator](https://github.com/Netflix/spectator-js) node module.

## Description

This module will generate node.js metrics using nflx-spectator. 

## Example

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

## Metrics generated

Note that all metrics will have a `nodejs.version` tag

### CPU
* `nodejs.cpuUsage`: Percentage of CPU time the node.js process is consuming
[0, 100]:
  * id: user
  * id: system

  For example:
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

### Event Loop

* `nodejs.eventLoop` timer, which measures the time it takes for the event loop
  to complete. This is sampled twice per second.

* `nodejs.eventLoopLag` timer, which measures if the event loop
	is running behind by attempting to execute a timer once a second, and
	measuring the actual lag.


### Garbage Collection Metrics

* `nodejs.gc.allocationRate`: measures in bytes/second how fast the app is
allocating memory

* `nodejs.gc.promotionRate`: measures in bytes/second how fast data is being
moved from `new_space` to `old_space`

* `nodejs.gc.liveDataSize`: measures in bytes the size of the `old_space` after
a major GC event

* `nodejs.gc.maxDataSize`: measures the maximum amount of memory the nodejs
process is allowed to use.  Primarly used for gaining perspective on the
`liveDataSize`.

* `nodejs.gc.pause`: times the time it takes for the different GC
events:

	 * `id=scavenge`: The most common garbage collection method. Node will
	typically trigger one of these every time the VM is idle.

	 * `id=markSweepCompact`: The heaviest type of garbage collection V8
	may do. If you see many of these happening you will need to either
	keep fewer objects around in your process or increase V8's heap
	limit

	 * `id=incrementalMarking`: A phased garbage collection that
	interleaves collection with application logic to reduce the amount
	of time the application is paused.

	 * `id=processWeakCallbacks`: After a garbage collection occurs, V8
	will call any weak reference callbacks registered for objects that
	have been freed. This measurement is from the start of the first
	weak callback to the end of the last for a given garbage collection.


### Memory Usage Metrics

  Memory usage of the Node.js process in bytes:

  * rss: `nodejs.rss`
  * heapTotal: `nodejs.heapTotal` - v8 memory usage
  * heapUsed: `nodejs.heapUsed` - v8 memory usage
  * external: `nodejs.external` - memory usage of C++ objects bound to JS objects managed by v8

### V8 Heap Statistics
* total_heap_size: `nodejs.totalHeapSize`

* total_heap_size_executable: `nodejs.totalHeapSizeExecutable`

* total_physical_size: `nodejs.totalPhysicalSize`

* total_available_size: `nodejs.totalAvailableSize`

* used_heap_size: `nodejs.usedHeapSize`

* heap_size_limit: `nodejs.heapSizeLimit`

* malloced_memory: `nodejs.mallocedMemory`

* peak_malloced_memory: `nodejs.peakMallocedMemory`

* does_zap_garbage: `nodejs.doesZapGarbage` -  a 0/1 boolean, which signifies
  whether the --zap_code_space option is enabled or not. This makes V8
  overwrite heap garbage with a bit pattern. The RSS footprint (resident memory
  set) gets bigger because it continuously touches all heap pages and that
  makes them less likely to get swapped out by the operating system.

### V8 Heap Space Statistics

For each space returned by [v8.getHeapSpaceStatistics](https://nodejs.org/api/v8.html#v8_v8_getheapspacestatistics)

* space_size: `nodejs.spaceSize` `id: <space_name>`
* space_used_size: `nodejs.spaceUsedSize` `id: <space_name>`
* space_available_size: `nodejs.spaceAvailableSize` `id: <space_name>`
* physical_space_size: `nodejs.physicalSpaceSize` `id: <space_name>`

### File descriptor usage

* Number currently opened: `openFileDescriptorsCount`

* Limit: `maxFileDescriptorsCount`
