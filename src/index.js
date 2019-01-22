'use strict';

const r = require('bindings')('spectator_internals');
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
        const tags = Object.assign({
          id: id
        }, extraTags);
        registry.gauge(name, tags).set(space[key]);
      }
    }
  }
}

class RuntimeMetrics {
  constructor(registry) {
    if (typeof process.cpuUsage !== 'function' ||
      typeof v8.getHeapSpaceStatistics !== 'function') {
      throw new Error('nflx-spectator-nodemetrics requires node.js 6 or newer');
    }

    this.registry = registry;
    this.started = false;
    this._intervals = [];
    const extraTags = {'nodejs.version': process.version};
    this.rss = registry.gauge('nodejs.rss', extraTags);
    this.heapTotal = registry.gauge('nodejs.heapTotal', extraTags);
    this.heapUsed = registry.gauge('nodejs.heapUsed', extraTags);
    this.external = registry.gauge('nodejs.external', extraTags);
    this.evtLoopTime = registry.timer('nodejs.eventLoop', extraTags);
    this.maxDataSize = registry.gauge('nodejs.gc.maxDataSize', extraTags);
    this.liveDataSize = registry.gauge('nodejs.gc.liveDataSize', extraTags);
    this.allocationRate = registry.counter('nodejs.gc.allocationRate', extraTags);
    this.promotionRate = registry.counter('nodejs.gc.promotionRate', extraTags);

    this.openFd = registry.gauge('openFileDescriptorsCount', extraTags);
    this.maxFd = registry.gauge('maxFileDescriptorsCount', extraTags);
    this.evtLoopLagTimer = registry.timer('nodejs.eventLoopLag', extraTags);
    this.cpuUsageUser = registry.gauge('nodejs.cpuUsage', {
      id: 'user',
      'nodejs.version': process.version
    });
    this.cpuUsageSystem = registry.gauge('nodejs.cpuUsage', {
      id: 'system',
      'nodejs.version': process.version
    });
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuUsageTime = registry.hrtime();
  }

  _gcEvents(emitGcFunction) {
    const self = this;
    let prevMapSize;
    let prevLargeSize;

    emitGcFunction((evt) => {
      // max data size
      self.maxDataSize.set(evt.after.heapSizeLimit);
      self.registry.timer('nodejs.gc.pause',
        {id: evt.type, 'nodejs.version': process.version}).record(evt.elapsed);

      const space = {};
      for (let idx = 0; idx < evt.before.heapSpaceStats.length; ++idx) {
        const name = evt.before.heapSpaceStats[idx].spaceName;
        if (name === 'new_space') {
          space.beforeNew = evt.before.heapSpaceStats[idx];
          space.afterNew = evt.after.heapSpaceStats[idx];
        } else if (name === 'old_space') {
          space.beforeOld = evt.before.heapSpaceStats[idx];
          space.afterOld = evt.after.heapSpaceStats[idx];
        } else if (name === 'map_space') {
          space.beforeMap = evt.before.heapSpaceStats[idx];
          space.afterMap = evt.after.heapSpaceStats[idx];
        } else if (name === 'large_object_space') {
          space.beforeLarge = evt.before.heapSpaceStats[idx];
          space.afterLarge = evt.after.heapSpaceStats[idx];
        }
      }

      if (space.beforeOld) {
        const oldBefore = space.beforeOld.spaceUsedSize;
        const oldAfter = space.afterOld.spaceUsedSize;
        if (oldAfter > oldBefore) {
          // data promoted to old_space
          self.promotionRate.add(oldAfter - oldBefore);
        }

        const live = self.liveDataSize;
        if (oldAfter < oldBefore || evt.type === 'markSweepCompact') {
          live.set(oldAfter);
        } else {
          // refresh it to prevent expiration of the gauge if no GC events occur
          live.set(live.get());
        }
      }

      if (space.beforeNew) {
        const youngBefore = space.beforeNew.spaceUsedSize;
        const youngAfter = space.afterNew.spaceUsedSize;

        if (youngBefore > youngAfter) {
          // garbage generated and collected
          self.allocationRate.add(youngBefore - youngAfter);
        }
      }

      if (space.beforeMap) {
        // compute the delta from our last GC event to now
        const mapBefore = space.beforeMap.spaceUsedSize;
        if (prevMapSize && mapBefore > prevMapSize) {
          self.allocationRate.add(mapBefore - prevMapSize);
        }
        prevMapSize = space.afterMap.spaceUsedSize;
      }

      if (space.beforeLarge) {
        // compute the delta from our last GC event to now
        const largeBefore = space.beforeLarge.spaceUsedSize;
        if (prevLargeSize && largeBefore > prevLargeSize) {
          self.allocationRate.add(largeBefore - prevLargeSize);
        }
        prevLargeSize = space.afterLarge.spaceUsedSize;
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
    RuntimeMetrics.updateFdGauges(this, r.GetCurMaxFd);
    const reg = this.registry;
    this._intervals.push(reg.schedulePeriodically(
      RuntimeMetrics.updateFdGauges, 10000, this, r.GetCurMaxFd));
  }

  static updateEvtLoopLag(self) {
    const now = self.registry.hrtime();
    const nanos = now[0] * 1e9 + now[1];
    const lag = nanos - self._lastNanos - 1e9;
    if (lag > 0) {
      self.evtLoopLagTimer.record(0, lag);
    }
    self._lastNanos = nanos;
  }

  _evtLoopLag() {
    const now = this.registry.hrtime();
    this._lastNanos = now[0] * 1e9 + now[1];
    const reg = this.registry;
    this._intervals.push(reg.schedulePeriodically(
      RuntimeMetrics.updateEvtLoopLag, 1000, this));
  }

  static measureEvtLoopTime(self) {
    setImmediate(() => {
      const start = self.registry.hrtime();
      setImmediate(() => {
        self.evtLoopTime.record(self.registry.hrtime(start));
      });
    });
  }

  _evtLoopTime() {
    const reg = this.registry;
    this._intervals.push(reg.schedulePeriodically(
      RuntimeMetrics.measureEvtLoopTime, 500, this));
    RuntimeMetrics.measureEvtLoopTime(this);
  }

  static measureCpuHeap(self) {
    const memUsage = process.memoryUsage();
    self.rss.set(memUsage.rss);
    self.heapTotal.set(memUsage.heapTotal);
    self.heapUsed.set(memUsage.heapUsed);
    self.external.set(memUsage.external);

    const newCpuUsage = process.cpuUsage();
    const newCpuUsageTime = process.hrtime();

    const elapsedMicros = deltaMicros(newCpuUsageTime, self.lastCpuUsageTime);
    updatePercentage(self.cpuUsageUser, newCpuUsage.user,
        self.lastCpuUsage.user, elapsedMicros);
    updatePercentage(self.cpuUsageSystem, newCpuUsage.system,
        self.lastCpuUsage.system, elapsedMicros);

    self.lastCpuUsageTime = newCpuUsageTime;
    self.lastCpuUsage = newCpuUsage;

    updateV8HeapGauges(self.registry,
        {'nodejs.version': process.version}, v8.getHeapStatistics());

    updateV8HeapSpaceGauges(self.registry, {'nodejs.version': process.version},
        v8.getHeapSpaceStatistics());
  }

  _cpuHeap() {
    RuntimeMetrics.measureCpuHeap(this);
    const reg = this.registry;
    this._intervals.push(reg.schedulePeriodically(RuntimeMetrics.measureCpuHeap, 10000, this));
  }

  start() {
    if (this.started) {
      this.registry.logger.info('nflx-spectator-nodejsmetrics already started');
      return;
    }

    this._gcEvents(r.EmitGCEvents);
    this._fdActivity();
    this._evtLoopLag();
    this._evtLoopTime();
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
