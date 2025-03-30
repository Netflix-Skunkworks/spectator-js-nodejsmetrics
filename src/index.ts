import v8 from "node:v8";
import bindings from "bindings";
import {Counter, Gauge, Registry, Tags, Timer} from "nflx-spectator";
import {HeapInfo, HeapSpaceInfo} from "v8";
import {EventLoopUtilityFunction, EventLoopUtilization, performance} from "perf_hooks";

const internals = bindings({
  try: [
    ["module_root", "..", "build", "Release", "spectator_internals.node"],
    ["module_root", "build", "Release", "spectator_internals.node"],
  ]
});

interface IndexedHeapInfo extends HeapInfo {
  [key: string]: number;
}

interface IndexedHeapSpaceInfo extends HeapSpaceInfo {
  [key: string]: number | string;
}

type EmitGcFunction = (arg0: (event: GcEvent) => void) => void;

type HeapSpaceInfoCamelCase = {
  spaceName: string;
  spaceSize: number;
  spaceUsedSize: number;
  spaceAvailableSize: number;
  physicalSpaceSize: number;
};

type GcEvent = {
  type: string;
  elapsed: number;
  before: {
    heapSpaceStats: HeapSpaceInfoCamelCase[];
  };
  after: {
    heapSizeLimit: number;
    heapSpaceStats: HeapSpaceInfoCamelCase[];
  };
};

type Space = {
  beforeNew?: HeapSpaceInfoCamelCase,
  afterNew?: HeapSpaceInfoCamelCase,
  beforeOld?: HeapSpaceInfoCamelCase,
  afterOld?: HeapSpaceInfoCamelCase,
  beforeMap?: HeapSpaceInfoCamelCase,
  afterMap?: HeapSpaceInfoCamelCase,
  beforeLarge?: HeapSpaceInfoCamelCase,
  afterLarge?: HeapSpaceInfoCamelCase,
};

function deltaMicros(end: [number, number], start: [number, number]): number {
  let deltaNanos: number = end[1] - start[1];
  let deltaSecs: number = end[0] - start[0];
  if (deltaNanos < 0) {
    deltaNanos += 1000000000;
    deltaSecs -= 1;
  }
  return Math.trunc(deltaSecs * 1e6 + deltaNanos / 1e3);
}

function updatePercentage(g: Gauge, currentUsed: number, prevUsed: number, totalMicros: number): void {
  const delta: number = currentUsed - prevUsed;
  const percentage: number = delta / totalMicros * 100.0;
  void g.set(percentage);
}

function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, function(g: string): string {
    return g[1].toUpperCase();
  });
}

function updateV8HeapGauges(r: Registry, extraTags: Tags, heapInfo: IndexedHeapInfo): void {
  for (const key of Object.keys(heapInfo)) {
    const name: string = "nodejs." + toCamelCase(key);
    void r.gauge(name, extraTags).set(heapInfo[key]);
  }
}

function updateV8HeapSpaceGauges(r: Registry, extraTags: Tags, heapSpaceInfos: IndexedHeapSpaceInfo[]): void {
  for (const space of heapSpaceInfos) {
    const id: string = toCamelCase(space.space_name);

    for (const key of Object.keys(space)) {
      if (key !== "space_name") {
        const name: string = "nodejs." + toCamelCase(key);
        const tags: Tags = Object.assign({"id": id}, extraTags);
        void r.gauge(name, tags).set(space[key] as number);
      }
    }
  }
}

export class RuntimeMetrics {
  public started: boolean = false;

  private registry: Registry;
  private intervals: NodeJS.Timeout[] = [];

  // metrics
  private external: Gauge;
  private heapTotal: Gauge;
  private heapUsed: Gauge;
  private rss: Gauge;

  private eventLoopActive: Gauge;
  private eventLoopLagTimer: Timer;
  private eventLoopTime: Timer;

  private allocationRate: Counter;
  private liveDataSize: Gauge;
  private maxDataSize: Gauge;
  private promotionRate: Counter;

  private openFd: Gauge;
  private maxFd: Gauge;

  private cpuUsageSystem: Gauge;
  private cpuUsageUser: Gauge;

  // data caches
  public eventLoopUtilization?: EventLoopUtilityFunction;
  public lastEventLoop?: EventLoopUtilization;
  public lastEventLoopTime?: [number, number];

  private lastCpuUsage?:  NodeJS.CpuUsage;
  private lastCpuUsageTime?: [number, number];
  private lastNanos: number = 0;
  private liveDataSizeCache?: number;

  constructor(r: Registry) {
    if (typeof process.cpuUsage !== "function" || typeof v8.getHeapSpaceStatistics !== "function") {
      throw new Error("nflx-spectator-nodemetrics requires Node.js >= 6.0");
    }

    this.registry = r;

    this.external = r.gauge("nodejs.external", this.withVersion());
    this.heapTotal = r.gauge("nodejs.heapTotal", this.withVersion());
    this.heapUsed = r.gauge("nodejs.heapUsed", this.withVersion());
    this.rss = r.gauge("nodejs.rss", this.withVersion());

    this.eventLoopActive = r.gauge("nodejs.eventLoopUtilization", this.withVersion());
    this.eventLoopLagTimer = r.timer("nodejs.eventLoopLag", this.withVersion());
    this.eventLoopTime = r.timer("nodejs.eventLoop", this.withVersion());

    this.allocationRate = r.counter("nodejs.gc.allocationRate", this.withVersion());
    this.liveDataSize = r.gauge("nodejs.gc.liveDataSize", this.withVersion());
    this.maxDataSize = r.gauge("nodejs.gc.maxDataSize", this.withVersion());
    this.promotionRate = r.counter("nodejs.gc.promotionRate", this.withVersion());

    this.openFd = r.gauge("openFileDescriptorsCount", this.withVersion());
    this.maxFd = r.gauge("maxFileDescriptorsCount", this.withVersion());

    this.cpuUsageSystem = r.gauge("nodejs.cpuUsage", this.withVersion({"id": "system"}));
    this.cpuUsageUser = r.gauge("nodejs.cpuUsage", this.withVersion({"id": "user"}));
  }

  withVersion(tags: Tags = {}): Tags {
    tags["nodejs.version"] = process.version;
    return tags;
  }

  measureGcEvents(emitGcFunction: EmitGcFunction): void {
    // this function becomes a callback in EmitGCEvents, so save a reference to the current object
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self: RuntimeMetrics = this;

    let prevMapSize: number;
    let prevLargeSize: number;

    emitGcFunction((event: GcEvent): void => {
      // max data size
      void self.maxDataSize.set(event.after.heapSizeLimit);
      void self.registry.timer("nodejs.gc.pause", self.withVersion({"id": event.type})).record(event.elapsed);

      const space: Space = {};

      for (let idx: number = 0; idx < event.before.heapSpaceStats.length; ++idx) {
        const name: string = event.before.heapSpaceStats[idx].spaceName;

        if (name === "new_space") {
          space.beforeNew = event.before.heapSpaceStats[idx];
          space.afterNew = event.after.heapSpaceStats[idx];
        } else if (name === "old_space") {
          space.beforeOld = event.before.heapSpaceStats[idx];
          space.afterOld = event.after.heapSpaceStats[idx];
        } else if (name === "map_space") {
          space.beforeMap = event.before.heapSpaceStats[idx];
          space.afterMap = event.after.heapSpaceStats[idx];
        } else if (name === "large_object_space") {
          space.beforeLarge = event.before.heapSpaceStats[idx];
          space.afterLarge = event.after.heapSpaceStats[idx];
        }
      }

      if (space.beforeOld && space.afterOld) {
        const oldBefore: number = space.beforeOld.spaceUsedSize;
        const oldAfter: number = space.afterOld.spaceUsedSize;

        if (oldAfter > oldBefore) {
          // data promoted to old_space
          void self.promotionRate.increment(oldAfter - oldBefore);
        }

        if (oldAfter < oldBefore || event.type === "markSweepCompact") {
          self.liveDataSizeCache = oldAfter;
          void self.liveDataSize.set(oldAfter);
        } else {
          // refresh the value, to prevent expiration of the gauge, if no GC events occur
          if (self.liveDataSizeCache !== undefined) {
            void self.liveDataSize.set(self.liveDataSizeCache);
          }
        }
      }

      let totalAllocationRate;

      if (space.beforeNew && space.afterNew) {
        const youngBefore: number = space.beforeNew.spaceUsedSize;
        const youngAfter: number = space.afterNew.spaceUsedSize;
        if (youngBefore > youngAfter) {
          // garbage generated and collected
          totalAllocationRate = youngBefore - youngAfter;
        }
      }

      if (space.beforeMap && space.afterMap) {
        // compute the delta from our last GC event to now
        const mapBefore: number = space.beforeMap.spaceUsedSize;

        if (prevMapSize && mapBefore > prevMapSize) {
          if (totalAllocationRate) {
            totalAllocationRate += mapBefore - prevMapSize;
          } else {
            totalAllocationRate = mapBefore - prevMapSize;
          }
        }

        prevMapSize = space.afterMap.spaceUsedSize;
      }

      if (space.beforeLarge && space.afterLarge) {
        // compute the delta from our last GC event to now
        const largeBefore: number = space.beforeLarge.spaceUsedSize;

        if (prevLargeSize && largeBefore > prevLargeSize) {
          if (totalAllocationRate) {
            totalAllocationRate += largeBefore - prevLargeSize;
          } else {
            totalAllocationRate = largeBefore - prevLargeSize;
          }
        }

        prevLargeSize = space.afterLarge.spaceUsedSize;
      }

      if (totalAllocationRate) {
        void self.allocationRate.increment(totalAllocationRate);
      }
    });
  }

  static measureFdActivity(self: RuntimeMetrics, fdFunction: () => any): void {
    const fd: any = fdFunction();
    void self.openFd.set(fd.used);
    if (fd.max) {
      void self.maxFd.set(fd.max);
    }
  }

  private initFdActivity(): void {
    RuntimeMetrics.measureFdActivity(this, internals.GetCurMaxFd);
    this.scheduleTask(RuntimeMetrics.measureFdActivity, 60000, this, internals.GetCurMaxFd);
  }

  static measureEventLoopLag(self: RuntimeMetrics): void {
    const now: [number, number] = process.hrtime();
    const nanos: number = now[0] * 1e9 + now[1];
    const lag: number = nanos - self.lastNanos;
    if (lag > 0) {
      void self.eventLoopLagTimer.record([0, lag]);
    }
    self.lastNanos = nanos;
  }

  private initEventLoopLag(): void {
    const now: [number, number] = process.hrtime();
    this.lastNanos = now[0] * 1e9 + now[1];
    this.scheduleTask(RuntimeMetrics.measureEventLoopLag, 1000, this);
  }

  static measureEventLoopTime(self: RuntimeMetrics): void {
    setImmediate((): void => {
      const start: [number, number] = process.hrtime();
      setImmediate((): void => {
        void self.eventLoopTime.record(process.hrtime(start));
      });
    });
  }

  private initEventLoopTime(): void {
    this.scheduleTask(RuntimeMetrics.measureEventLoopTime, 500, this);
    RuntimeMetrics.measureEventLoopTime(this);
  }

  static measureEventLoopUtilization(self: RuntimeMetrics): void {
    if (!self.eventLoopUtilization) return;

    const now: [number, number] = process.hrtime();
    const nanos: number = now[0] * 1e9 + now[1];

    let lastNanos: number | undefined;
    let deltaNanos: number | undefined;

    if (self.lastEventLoopTime) {
      lastNanos = self.lastEventLoopTime[0] * 1e9 + self.lastEventLoopTime[1];
      deltaNanos = nanos - lastNanos;
    }

    const current: EventLoopUtilization = self.eventLoopUtilization();
    const active: number = current.active * 1e6;
    let deltaActive: number | undefined;

    if (self.lastEventLoop) {
      const last: EventLoopUtilization = self.lastEventLoop;
      deltaActive = active - last.active * 1e6;
    }

    if (deltaActive && deltaNanos) {
      void self.eventLoopActive.set(100.0 * deltaActive / deltaNanos);
    }

    self.lastEventLoopTime = now;
    self.lastEventLoop = current;
  }

  private initEventLoopUtilization(): void {
    let eventLoopUtilization: EventLoopUtilityFunction;

    try {
      eventLoopUtilization = performance.eventLoopUtilization;
    } catch (e) {
      this.registry.logger.debug(`Failed to assign performance.eventLoopUtilization, got: ${e}`);
      return;
    }

    if (typeof eventLoopUtilization !== "function") {
      this.registry.logger.info(`Unable to measure eventLoopUtilization. Requires Nodejs v12.19.0 or newer: ${process.version}`);
      return;
    }

    this.eventLoopUtilization = eventLoopUtilization;
    this.lastEventLoopTime = process.hrtime();
    this.lastEventLoop = this.eventLoopUtilization();
    this.scheduleTask(RuntimeMetrics.measureEventLoopUtilization, 60000, this);
  }

  static measureCpuHeap(self: RuntimeMetrics): void {
    const memUsage: NodeJS.MemoryUsage = process.memoryUsage();
    void self.rss.set(memUsage.rss);
    void self.heapTotal.set(memUsage.heapTotal);
    void self.heapUsed.set(memUsage.heapUsed);
    void self.external.set(memUsage.external);

    const newCpuUsage: NodeJS.CpuUsage = process.cpuUsage();
    const newCpuUsageTime: [number, number] = process.hrtime();

    if (self.lastCpuUsage && self.lastCpuUsageTime) {
      const elapsedMicros: number = deltaMicros(newCpuUsageTime, self.lastCpuUsageTime);
      updatePercentage(self.cpuUsageUser, newCpuUsage.user, self.lastCpuUsage.user, elapsedMicros);
      updatePercentage(self.cpuUsageSystem, newCpuUsage.system, self.lastCpuUsage.system, elapsedMicros);
    }

    self.lastCpuUsageTime = newCpuUsageTime;
    self.lastCpuUsage = newCpuUsage;

    updateV8HeapGauges(self.registry, self.withVersion(), v8.getHeapStatistics() as IndexedHeapInfo);
    updateV8HeapSpaceGauges(self.registry, self.withVersion(), v8.getHeapSpaceStatistics() as IndexedHeapSpaceInfo[]);
  }

  private initCpuHeap(): void {
    this.scheduleTask(RuntimeMetrics.measureCpuHeap, 60000, this);
  }

  start(): void {
    if (this.started) {
      this.registry.logger.info("nflx-spectator-nodejsmetrics already started");
      return;
    }

    this.measureGcEvents(internals.EmitGCEvents);
    this.initFdActivity();
    this.initEventLoopLag();
    this.initEventLoopTime();
    this.initEventLoopUtilization();
    this.initCpuHeap();
    this.started = true;
  }

  stop(): void {
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.started = false;
  }

  scheduleTask(...args: any): void {
    const id: NodeJS.Timeout = setInterval.apply(this, args);
    id.unref();
    this.intervals.push(id);
  }
}
