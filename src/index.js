const internals = require('bindings')('spectator_internals');
const v8 = require('v8');

function deltaMicros(end, start) {
  let deltaNanos = end[1] - start[1];
  let deltaSecs = end[0] - start[0];

  if (deltaNanos < 0) {
    deltaNanos += 1000000000;
    deltaSecs -= 1;
  }

  return Math.trunc(deltaSecs * 1e6 + deltaNanos / 1e3);
}

function updatePercentage(gauge, currentUsed, prevUsed, totalMicros) {
  const delta = currentUsed - prevUsed;
  const percentage = delta / totalMicros * 100.0;
  gauge.set(percentage);
}

function toCamelCase(s) {
  return s.replace(/_([a-z])/g, function(g) {
    return g[1].toUpperCase();
  });
}

function updateV8HeapGauges(registry, extraTags, heapStats) {
  for (const key of Object.keys(heapStats)) {
    const name = 'nodejs.' + toCamelCase(key);
    registry.gauge(name, extraTags).set(heapStats[key]);
  }
}

function updateV8HeapSpaceGauges(registry, extraTags, heapSpaceStats) {
  for (const space of heapSpaceStats) {
    const id = toCamelCase(space.space_name);

    for (const key of Object.keys(space)) {
      if (key !== 'space_name') {
        const name = 'nodejs.' + toCamelCase(key);
        const tags = Object.assign({'id': id}, extraTags);
        registry.gauge(name, tags).set(space[key]);
      }
    }
  }
}

/**
 * Translate high resolution time into a number of seconds, for recording a timer value.
 *
 * @param {number|number[]} seconds
 *     Number of seconds, which may be fractional, or an array of two numbers [seconds, nanoseconds],
 *     such as the return value from process.hrtime().
 *
 * @param {number} [nanos]
 *     If seconds is a number, then nanos will be interpreted as a number of nanoseconds.
 *
 * @return {number}
 *     The total number of seconds that have elapsed, which may be fractional. Any negative values
 *     that are calculated will be discarded by the Timer implementation of spectator-js.
 */
function hrSeconds(seconds, nanos) {
  let totalSeconds;

  if (seconds instanceof Array) {
    totalSeconds = seconds[0] + (seconds[1] / 1e9 || 0);
  } else {
    totalSeconds = seconds + (nanos / 1e9 || 0);
  }

  return totalSeconds;
}

function schedulePeriodically(args) {
  const id = setInterval.apply(this, arguments);
  id.unref();
  return id;
}

class RuntimeMetrics {
  constructor(registry) {
    if (typeof process.cpuUsage !== 'function' || typeof v8.getHeapSpaceStatistics !== 'function') {
      throw new Error('nflx-spectator-nodemetrics requires Node.js >= 6.0');
    }

    this.registry = registry;
    this.started = false;
    this._intervals = [];
    this._versionTag = {'nodejs.version': process.version};

    this.external = registry.gauge('nodejs.external', this._versionTag);
    this.heapTotal = registry.gauge('nodejs.heapTotal', this._versionTag);
    this.heapUsed = registry.gauge('nodejs.heapUsed', this._versionTag);
    this.rss = registry.gauge('nodejs.rss', this._versionTag);

    this.eventLoopActive = registry.gauge('nodejs.eventLoopUtilization', this._versionTag);
    this.eventLoopLagTimer = registry.timer('nodejs.eventLoopLag', this._versionTag);
    this.eventLoopTime = registry.timer('nodejs.eventLoop', this._versionTag);

    this.allocationRate = registry.counter('nodejs.gc.allocationRate', this._versionTag);
    this.liveDataSize = registry.gauge('nodejs.gc.liveDataSize', this._versionTag);
    this.maxDataSize = registry.gauge('nodejs.gc.maxDataSize', this._versionTag);
    this.promotionRate = registry.counter('nodejs.gc.promotionRate', this._versionTag);

    this.openFd = registry.gauge('openFileDescriptorsCount', this._versionTag);
    this.maxFd = registry.gauge('maxFileDescriptorsCount', this._versionTag);

    this.cpuUsageSystem = registry.gauge('nodejs.cpuUsage', {'id': 'system', 'nodejs.version': process.version});
    this.cpuUsageUser = registry.gauge('nodejs.cpuUsage', {'id': 'user', 'nodejs.version': process.version});
  }

  _gcEvents(emitGcFunction) {
    const self = this;
    let prevMapSize;
    let prevLargeSize;

    emitGcFunction((event) => {
      // max data size
      self.maxDataSize.set(event.after.heapSizeLimit);
      self.registry.timer('nodejs.gc.pause', {'id': event.type, 'nodejs.version': process.version}).record(event.elapsed);

      const space = {};
      for (let idx = 0; idx < event.before.heapSpaceStats.length; ++idx) {
        const name = event.before.heapSpaceStats[idx].spaceName;
        if (name === 'new_space') {
          space.beforeNew = event.before.heapSpaceStats[idx];
          space.afterNew = event.after.heapSpaceStats[idx];
        } else if (name === 'old_space') {
          space.beforeOld = event.before.heapSpaceStats[idx];
          space.afterOld = event.after.heapSpaceStats[idx];
        } else if (name === 'map_space') {
          space.beforeMap = event.before.heapSpaceStats[idx];
          space.afterMap = event.after.heapSpaceStats[idx];
        } else if (name === 'large_object_space') {
          space.beforeLarge = event.before.heapSpaceStats[idx];
          space.afterLarge = event.after.heapSpaceStats[idx];
        }
      }

      if (space.beforeOld) {
        const oldBefore = space.beforeOld.spaceUsedSize;
        const oldAfter = space.afterOld.spaceUsedSize;
        if (oldAfter > oldBefore) {
          // data promoted to old_space
          self.promotionRate.increment(oldAfter - oldBefore);
        }

        if (oldAfter < oldBefore || event.type === 'markSweepCompact') {
          self._liveDataSizeCache = oldAfter;
          self.liveDataSize.set(oldAfter);
        } else {
          // refresh the value, to prevent expiration of the gauge, if no GC events occur
          if (self._liveDataSizeCache !== undefined) {
            self.liveDataSize.set(self._liveDataSizeCache);
          }
        }
      }

      let totalAllocationRate;
      if (space.beforeNew) {
        const youngBefore = space.beforeNew.spaceUsedSize;
        const youngAfter = space.afterNew.spaceUsedSize;
        if (youngBefore > youngAfter) {
          // garbage generated and collected
          totalAllocationRate = youngBefore - youngAfter;
        }
      }

      if (space.beforeMap) {
        // compute the delta from our last GC event to now
        const mapBefore = space.beforeMap.spaceUsedSize;
        if (prevMapSize && mapBefore > prevMapSize) {
          totalAllocationRate += mapBefore - prevMapSize;
        }
        prevMapSize = space.afterMap.spaceUsedSize;
      }

      if (space.beforeLarge) {
        // compute the delta from our last GC event to now
        const largeBefore = space.beforeLarge.spaceUsedSize;
        if (prevLargeSize && largeBefore > prevLargeSize) {
          totalAllocationRate += largeBefore - prevLargeSize;
        }
        prevLargeSize = space.afterLarge.spaceUsedSize;
      }

      if (totalAllocationRate !== undefined) {
        self.allocationRate.increment(totalAllocationRate);
      }
    });
  }

  static updateFdGauges(self, fdFunction) {
    const fd = fdFunction();
    self.openFd.set(fd.used);
    if (fd.max) {
      self.maxFd.set(fd.max);
    }
  }

  _fdActivity() {
    RuntimeMetrics.updateFdGauges(this, internals.GetCurMaxFd);
    this._intervals.push(schedulePeriodically(RuntimeMetrics.updateFdGauges, 60000, this, internals.GetCurMaxFd));
  }

  static updateEventLoopLag(self) {
    const now = process.hrtime();
    const nanos = now[0] * 1e9 + now[1];
    const lag = nanos - self._lastNanos - 1e9;
    if (lag > 0) {
      self.eventLoopLagTimer.record(hrSeconds(0, lag));
    }
    self._lastNanos = nanos;
  }

  _eventLoopLag() {
    const now = process.hrtime();
    this._lastNanos = now[0] * 1e9 + now[1];
    this._intervals.push(schedulePeriodically(RuntimeMetrics.updateEventLoopLag, 1000, this));
  }

  static measureEventLoopTime(self) {
    setImmediate(() => {
      const start = process.hrtime();
      setImmediate(() => {
        self.eventLoopTime.record(hrSeconds(process.hrtime(start)));
      });
    });
  }

  _eventLoopTime() {
    this._intervals.push(schedulePeriodically(RuntimeMetrics.measureEventLoopTime, 500, this));
    RuntimeMetrics.measureEventLoopTime(this);
  }

  static measureEventLoopUtilization(self) {
    const now = process.hrtime();  // `[seconds, nanoseconds]` tuple `Array`
    const nanos = now[0] * 1e9 + now[1];
    const lastNanos = self.lastEventLoopTime[0] * 1e9 + self.lastEventLoopTime[1];

    const deltaNanos = nanos - lastNanos;
    const last = self.lastEventLoop;
    const current = self.eventLoopUtilization();
    const active = current.active * 1e6;
    const deltaActive = active - last.active * 1e6;
    self.eventLoopActive.set(100.0 * deltaActive / deltaNanos);

    self.lastEventLoopTime = now;
    self.lastEventLoop = current;
  }

  _eventLoopUtilization() {
    let eventLoopUtilization;

    try {
      eventLoopUtilization = require('perf_hooks').performance.eventLoopUtilization;
    } catch (e) {
      this.registry.logger.debug(`Got: ${e}`);
    }

    if (typeof eventLoopUtilization !== 'function') {
      this.registry.logger.info(`Unable to measure eventLoopUtilization. Requires Nodejs v12.19.0 or newer: ${process.version}`);
      return;
    }

    this.eventLoopUtilization = eventLoopUtilization;
    this.lastEventLoopTime = process.hrtime();  // `[seconds, nanoseconds]` tuple `Array`
    this.lastEventLoop = this.eventLoopUtilization();
    this._intervals.push(schedulePeriodically(RuntimeMetrics.measureEventLoopUtilization, 60000, this));
  }

  static measureCpuHeap(self) {
    const memUsage = process.memoryUsage();
    self.rss.set(memUsage.rss);
    self.heapTotal.set(memUsage.heapTotal);
    self.heapUsed.set(memUsage.heapUsed);
    self.external.set(memUsage.external);

    const newCpuUsage = process.cpuUsage();
    const newCpuUsageTime = process.hrtime();  // `[seconds, nanoseconds]` tuple `Array`

    const elapsedMicros = deltaMicros(newCpuUsageTime, self.lastCpuUsageTime);
    updatePercentage(self.cpuUsageUser, newCpuUsage.user, self.lastCpuUsage.user, elapsedMicros);
    updatePercentage(self.cpuUsageSystem, newCpuUsage.system, self.lastCpuUsage.system, elapsedMicros);

    self.lastCpuUsageTime = newCpuUsageTime;
    self.lastCpuUsage = newCpuUsage;

    updateV8HeapGauges(self.registry, {'nodejs.version': process.version}, v8.getHeapStatistics());
    updateV8HeapSpaceGauges(self.registry, {'nodejs.version': process.version}, v8.getHeapSpaceStatistics());
  }

  _cpuHeap() {
    this._intervals.push(schedulePeriodically(RuntimeMetrics.measureCpuHeap, 60000, this));
  }

  start() {
    if (this.started) {
      this.registry.logger.info('nflx-spectator-nodejsmetrics already started');
      return;
    }

    this._gcEvents(internals.EmitGCEvents);
    this._fdActivity();
    this._eventLoopLag();
    this._eventLoopTime();
    this._eventLoopUtilization();
    this._cpuHeap();
    this.started = true;
  }

  stop() {
    for (let interval of this._intervals) {
      clearInterval(interval);
    }
    this.started = false;
  }
}

module.exports = RuntimeMetrics;
