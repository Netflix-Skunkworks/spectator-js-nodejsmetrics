import v8 from "node:v8";

// Minimal per-space shape consumed by the GC metric math in RuntimeMetrics.
export interface GcHeapSpace {
  spaceName: string;
  spaceUsedSize: number;
}

// A single garbage-collection event. Intentionally shaped identically to the event the
// previous native addon emitted, so the metric math in RuntimeMetrics is unchanged.
export interface GcEvent {
  type: string;      // normalized GC kind, e.g. "scavenge", "markSweepCompact"
  elapsed: number;   // GC pause, in seconds
  before: {heapSpaceStats: GcHeapSpace[]};
  after: {heapSizeLimit: number; heapSpaceStats: GcHeapSpace[]};
}

export type GcCallback = (event: GcEvent) => void;
export type GcErrorCallback = (error: unknown) => void;

// The subset of v8.GCProfiler output we read. Declared locally so the code compiles
// regardless of how precisely @types/node models GCProfiler's result internals.
interface ProfilerSpace {
  spaceName: string;
  spaceUsedSize: number;
}
interface ProfilerSnapshot {
  heapStatistics: {heapSizeLimit: number};
  heapSpaceStatistics: ProfilerSpace[];
}
interface ProfilerRecord {
  gcType: string;
  cost: number;  // GC pause, in microseconds
  beforeGC: ProfilerSnapshot;
  afterGC: ProfilerSnapshot;
}
interface ProfilerResult {
  statistics?: ProfilerRecord[];
}

// v8.GCProfiler reports gcType as a PascalCase string; map it to the id-tag values the
// previous v8::GCType-based implementation used, so the nodejs.gc.pause "id" tag is stable.
const GC_TYPE_NAMES: Readonly<Record<string, string>> = {
  Scavenge: "scavenge",
  MinorMarkCompact: "minorMarkCompact",
  MinorMarkSweep: "minorMarkSweep",
  MarkSweepCompact: "markSweepCompact",
  IncrementalMarking: "incrementalMarking",
  ProcessWeakCallbacks: "processWeakCallbacks",
};

function toGcEvent(record: ProfilerRecord): GcEvent {
  // Reference the profiler's space arrays directly rather than copying them. ProfilerSpace is
  // structurally a GcHeapSpace (the profiler objects just carry extra fields RuntimeMetrics
  // ignores), and the profiler result is discarded right after this drain, so there is nothing
  // to retain. This avoids allocating ~2*N throwaway objects per GC event -- churn that, in a GC
  // metrics collector, would itself provoke more collections.
  return {
    type: GC_TYPE_NAMES[record.gcType] ?? "unknown",
    elapsed: record.cost / 1e6,  // microseconds -> seconds
    before: {heapSpaceStats: record.beforeGC.heapSpaceStatistics},
    after: {
      heapSizeLimit: record.afterGC.heapStatistics.heapSizeLimit,
      heapSpaceStats: record.afterGC.heapSpaceStatistics,
    },
  };
}

// Observes garbage-collection events via v8.GCProfiler and delivers one GcEvent per GC.
//
// GCProfiler is a batch API: start() begins recording, stop() returns everything recorded
// since. To deliver events continuously we drain on an unref'd interval -- stop the running
// profiler, hand off its records, and immediately start a fresh one. The stop/start gap is a
// few synchronous statements, so a GC landing exactly inside it is missed; that is immaterial
// for these rate/pause metrics, which spectator aggregates over seconds.
export class GcEventSource {
  private readonly drainIntervalMs: number;
  private profiler?: InstanceType<typeof v8.GCProfiler>;
  private timer?: NodeJS.Timeout;
  private onEvent?: GcCallback;
  private onError?: GcErrorCallback;

  constructor(drainIntervalMs = 1000) {
    this.drainIntervalMs = drainIntervalMs;
  }

  // Begins delivering GcEvents to onEvent. Returns false if v8.GCProfiler is unavailable
  // (Node < 18.15), in which case GC metrics are simply not collected. onError, if provided, is
  // invoked when the profiler throws; collection is then disarmed rather than allowed to crash
  // the host (see drain).
  start(onEvent: GcCallback, onError?: GcErrorCallback): boolean {
    if (typeof v8.GCProfiler !== "function") {
      return false;
    }
    if (this.profiler) {
      return true;  // already running
    }

    this.onEvent = onEvent;
    this.onError = onError;
    this.profiler = new v8.GCProfiler();
    this.profiler.start();
    this.timer = setInterval((): void => this.drain(), this.drainIntervalMs);
    this.timer.unref();  // must never keep the process alive
    return true;
  }

  stop(): void {
    this.clearTimer();
    if (this.profiler) {
      // Deliver whatever was recorded since the last drain before tearing down, so the final
      // (up to drainIntervalMs) batch of GC events is not dropped on stop().
      try {
        const result = this.profiler.stop() as unknown as ProfilerResult;
        this.profiler = undefined;
        this.deliver(result);
      } catch (e) {
        this.profiler = undefined;
        this.onError?.(e);
      }
    }
    this.onEvent = undefined;
    this.onError = undefined;
  }

  // Hands every GC recorded since the last drain to the callback, then resumes recording.
  // Public so tests can force delivery without waiting for the interval. This runs on an unref'd
  // interval in production, so an unhandled throw here would surface as an uncaughtException; a
  // metrics collector must never crash its host, so any failure disarms collection and is
  // reported via onError instead.
  drain(): void {
    if (!this.profiler || !this.onEvent) {
      return;
    }
    try {
      const result = this.profiler.stop() as unknown as ProfilerResult;
      this.profiler = new v8.GCProfiler();
      this.profiler.start();
      this.deliver(result);
    } catch (e) {
      // Disarm so a persistent failure does not throw on every interval; drop any profiler we
      // may hold (e.g. one started just above) without letting its stop() throw again.
      this.clearTimer();
      try {
        this.profiler?.stop();
      } catch {
        // ignore
      }
      this.profiler = undefined;
      this.onError?.(e);
    }
  }

  private deliver(result: ProfilerResult): void {
    const onEvent = this.onEvent;
    const stats = result.statistics;
    if (!onEvent || !stats) {
      return;
    }
    for (const record of stats) {
      onEvent(toGcEvent(record));
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
