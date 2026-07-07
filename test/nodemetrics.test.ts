/// <reference types="mocha" />
import fs from "node:fs";
import v8 from "node:v8";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import path from "node:path";
import {Config, MemoryWriter, parse_protocol_line, Registry} from "nflx-spectator";
import {assert} from "chai";
import {RuntimeMetrics} from "../src/index.js"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: (value: void | PromiseLike<void>) => void): void => {
    setTimeout(resolve, ms);
  });
}

// Runs a child-process fixture from test/fixtures/<name>.cjs with --expose-gc. The fixture
// body is prepended with the shared prelude and executed via `-e`, so require('.') resolves
// against the package root exactly like an inline script would.
function runChildScript(name: string) {
  const prelude = fs.readFileSync("test/fixtures/_prelude.cjs", "utf8");
  const body = fs.readFileSync(`test/fixtures/${name}.cjs`, "utf8");
  return spawnSync(process.execPath, ["--expose-gc", "-e", `${prelude}\n${body}`], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

// The raw native addon (not re-exported by the JS index) loaded straight from the built binary,
// so tests can call its functions directly. cwd is the package root under mocha.
type FdStats = {used: number, max: number | null};
const internals = createRequire(import.meta.url)(
  path.resolve("build/Release/spectator_internals.node")
) as {GetCurMaxFd: () => FdStats};

// Child-process tests: crash/exit safety and the start/stop/worker lifecycle of the native addon.
describe("nodemetrics: process lifecycle and crash safety", (): void => {

  it("should not prevent node from exiting", (): void => {
    // ensure `start()` with no `stop()` does not prevent mocha from exiting
    const r = new Registry(new Config("memory"));
    const metrics = new RuntimeMetrics(r);
    metrics.start();
  });

  it("should not abort when the process exits after loading the addon", (): void => {
    const result = spawnSync(process.execPath, ["-e", "require('.'); console.log('loaded')"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "loaded");
  });

  it("should emit gc metrics after multiple runtime metrics instances register gc callbacks", (): void => {
    const result = runChildScript("multi-instance");

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "gc metrics emitted");
  });

  it("should emit gc metrics from worker thread isolates", (): void => {
    const result = runChildScript("worker-isolates-main");

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "gc metrics emitted");
  });

  it("should stop emitting gc metrics after stop unregisters the native callback", (): void => {
    const result = runChildScript("stop");

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "gc metrics stopped");
  });

  it("should emit gc metrics after start stop start", (): void => {
    const result = runChildScript("start-stop-start");

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "gc metrics restarted");
  });
});

// Accuracy: native-captured values (child process) and exact transform/wiring (in-process mocks).
describe("nodemetrics: metric accuracy", (): void => {

  it("should capture accurate native GC heap statistics", (): void => {
    // cross-checks the raw native EmitGCEvents snapshots against node:v8 invariants
    const result = runChildScript("gc-accuracy");

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "GC_ACCURACY_OK");
  });

  it("should capture accurate file descriptor stats via native GetCurMaxFd", (): void => {
    // used: linux tracks real open fds via /proc; macOS/bsd has no /proc, so it is always 0.
    // max: getrlimit(RLIMIT_NOFILE) -> null (unlimited) or a positive integer, on both platforms.
    const shapeOk = (s: FdStats): boolean =>
      Number.isFinite(s.used) && s.used >= 0 &&
      (s.max === null || (Number.isInteger(s.max) && s.max > 0));

    const before = internals.GetCurMaxFd();
    assert.isTrue(shapeOk(before), `bad shape: ${JSON.stringify(before)}`);

    const fds: number[] = [];
    try {
      for (let i = 0; i < 16; ++i) {
        fds.push(fs.openSync(process.execPath, "r"));  // open a file that is guaranteed to exist
      }
      const after = internals.GetCurMaxFd();
      assert.isTrue(shapeOk(after), `bad shape: ${JSON.stringify(after)}`);

      if (process.platform === "linux") {
        // counts the 16 we opened (plus the transient opendir fd), so it rises by at least 16
        assert.isAtLeast(after.used - before.used, 16, "used should rise by >= 16 after opening 16 files");
      } else {
        assert.equal(after.used, 0, "used should be 0 on platforms without /proc/self/fd");
      }
      // max is a fixed process limit; it must not change between samples
      assert.equal(after.max, before.max);
    } finally {
      for (const fd of fds) {
        fs.closeSync(fd);
      }
    }
  });

  it("should report the exact process cpu/heap/v8 values from their sources", (): void => {
    // Deterministic accuracy check: stub every source measureCpuHeap reads, then assert each
    // emitted meter equals the exact transform of the stubbed value (correct name, tag, units).
    const camel = (s: string): string => s.replace(/_([a-z])/g, (g: string): string => g[1].toUpperCase());

    // stubbed values to be returned by process.memoryUsage(), process.cpuUsage(), process.hrtime(),
    // v8.getHeapStatistics(), and v8.getHeapSpaceStatistics(). The deltas are chosen to be
    // non-zero and easy to compute, so the emitted metrics can be asserted against them.
    const MEM = {rss: 1001, heapTotal: 2002, heapUsed: 3003, external: 4004, arrayBuffers: 5005};
    const CPU = [{user: 1000, system: 500}, {user: 5000, system: 2000}];  // deltas: 4000 user, 1500 system
    const HR: Array<[number, number]> = [[0, 0], [2, 0]];                  // deltaMicros = 2_000_000
    const HEAP: {[k: string]: number} = {
      total_heap_size: 10,
      used_heap_size: 20,
      heap_size_limit: 30,
      malloced_memory: 40,
      number_of_native_contexts: 50
    };
    const SPACES = [
      {space_name: "new_space", space_size: 11, space_used_size: 12, space_available_size: 13, physical_space_size: 14},
      {space_name: "large_object_space", space_size: 21, space_used_size: 22, space_available_size: 23, physical_space_size: 24}
    ];

    // The Registry, MemoryWriter, and RuntimeMetrics under test. The MemoryWriter is used to capture
    // the emitted metrics so they can be asserted against the stubbed values above.
    const r = new Registry(new Config("memory"));
    const writer = r.writer() as MemoryWriter;
    const metrics = new RuntimeMetrics(r);

    // The stub() helper replaces a property on an object with a getter that returns a fixed value, and saves the original property 
    // descriptor so it can be restored later. The stubbed properties are:
    // - process.memoryUsage
    // - process.cpuUsage
    // - process.hrtime
    // - v8.getHeapStatistics
    // - v8.getHeapSpaceStatistics
    let cpuIdx = 0;
    let hrIdx = 0;
    const saved: Array<{obj: any, key: string, desc: PropertyDescriptor | undefined}> = [];
    const stub = (obj: any, key: string, value: unknown): void => {
      saved.push({obj, key, desc: Object.getOwnPropertyDescriptor(obj, key)});
      Object.defineProperty(obj, key, {value, configurable: true, writable: true});
    };

    // The try/finally block ensures that the original properties are restored after the test, even if an assertion fails. 
    try {
      stub(process, "memoryUsage", (): unknown => MEM);
      stub(process, "cpuUsage", (): unknown => CPU[cpuIdx++]);
      stub(process, "hrtime", (): [number, number] => HR[hrIdx++]);
      stub(v8, "getHeapStatistics", (): unknown => ({...HEAP}));
      stub(v8, "getHeapSpaceStatistics", (): unknown => SPACES.map((s) => ({...s})));

      RuntimeMetrics.measureCpuHeap(metrics);  // baseline: sets lastCpuUsage, no cpuUsage emitted yet
      writer.clear();
      RuntimeMetrics.measureCpuHeap(metrics);  // emits memory + cpuUsage delta + v8 heap/space gauges
    } finally {
      for (const {obj, key, desc} of saved) {
        if (desc) {
          Object.defineProperty(obj, key, desc);
        } else {
          delete obj[key];
        }
      }
    }

    // The emitted metrics are captured in the MemoryWriter. The test iterates over each line, parses it, and checks that the values match the expected values based on the stubbed sources. 
    // It also counts how many gauges were emitted without an "id" tag, which should match the expected number of memoryUsage and heap space gauges.
    const byKey = new Map<string, number>();
    let idlessGauges = 0;
    for (const line of writer.get()) {
      const [, id, value] = parse_protocol_line(line);
      const idTag: string = id.tags()["id"] ?? "";
      byKey.set(`${id.name()}|${idTag}`, parseFloat(value));
      assert.equal(id.tags()["nodejs.version"], process.version, `${id.name()} missing version tag`);
      if (idTag === "") {
        idlessGauges++;
      }
    }

    // process.memoryUsage() pass-throughs, verbatim
    assert.equal(byKey.get("nodejs.rss|"), 1001);
    assert.equal(byKey.get("nodejs.heapTotal|"), 2002);
    assert.equal(byKey.get("nodejs.heapUsed|"), 3003);
    assert.equal(byKey.get("nodejs.external|"), 4004);

    // process.cpuUsage() delta expressed as a percentage of elapsed wall-clock micros
    assert.closeTo(byKey.get("nodejs.cpuUsage|user") as number, 4000 / 2_000_000 * 100, 1e-9);   // 0.2
    assert.closeTo(byKey.get("nodejs.cpuUsage|system") as number, 1500 / 2_000_000 * 100, 1e-9); // 0.075

    // v8.getHeapStatistics(): every key mapped to nodejs.<camelCase(key)> with the exact value
    for (const key of Object.keys(HEAP)) {
      assert.equal(byKey.get(`nodejs.${camel(key)}|`), HEAP[key], `heap key ${key}`);
    }
    // exactly the 4 memoryUsage gauges + one per heap key, nothing missing or spurious
    assert.equal(idlessGauges, 4 + Object.keys(HEAP).length);

    // v8.getHeapSpaceStatistics(): per-space gauges tagged id=<camelCase(space_name)>
    for (const space of SPACES) {
      const spaceId = camel(space.space_name);
      for (const key of Object.keys(space)) {
        if (key === "space_name") {
          continue;
        }
        assert.equal(byKey.get(`nodejs.${camel(key)}|${spaceId}`), (space as {[k: string]: unknown})[key],
          `${space.space_name}.${key}`);
      }
    }
  });

  it("should report the exact event loop time from process.hrtime", async (): Promise<void> => {
    const r = new Registry(new Config("memory"));
    const writer = r.writer() as MemoryWriter;
    const metrics = new RuntimeMetrics(r);

    // measureEventLoopTime does: start = hrtime(); then record(hrtime(start)). Feed a 5ms diff.
    const HR: Array<[number, number]> = [[0, 0], [0, 5_000_000]];
    let hrIdx = 0;
    const orig = Object.getOwnPropertyDescriptor(process, "hrtime");
    try {
      Object.defineProperty(process, "hrtime", {
        value: (): [number, number] => HR[hrIdx++],
        configurable: true,
        writable: true
      });

      RuntimeMetrics.measureEventLoopTime(metrics);
      // wait out the two nested setImmediate() hops before the record fires
      await new Promise<void>((resolve): void => {
        setImmediate((): void => {
          setImmediate((): void => resolve());
        });
      });
    } finally {
      if (orig) {
        Object.defineProperty(process, "hrtime", orig);
      }
    }

    const lines = writer.get();
    assert.equal(lines.length, 1, lines.join("\n"));
    const [, id, value] = parse_protocol_line(lines[0]);
    assert.equal(id.name(), "nodejs.eventLoop");
    assert.equal(id.tags()["nodejs.version"], process.version);
    assert.closeTo(parseFloat(value), 0.005, 1e-9);  // 5ms
  });
});

// The original per-measure-method transform tests plus general start()/started behavior.
describe("nodemetrics: metric collection and behavior", (): void => {

  it("should generate a few meters", async (): Promise<void> => {
    // ensure `start()` actually starts the collection
    const r = new Registry(new Config("memory"));
    const writer = r.writer() as MemoryWriter;
    const metrics = new RuntimeMetrics(r);
    metrics.start();

    await sleep(100);  // tiny pause is necessary to see data

    assert.isTrue(writer.get().length >= 3);
  });

  it("should collect gc metrics", (): void => {
    const gcEvents = JSON.parse(fs.readFileSync("test/resources/gc-events.json").toString());
    const r = new Registry(new Config("memory"));
    const writer = r.writer() as MemoryWriter;

    let nanos: number = 0;
    const f: NodeJS.HRTime = process.hrtime;
    Object.defineProperty(process, "hrtime", {
      get(): () => [number, number] {
        return (): [number, number] => {
          nanos += 1e6;
          return [0, nanos];
        };
      }
    });

    const metrics = new RuntimeMetrics(r);

    let mapSize: number | undefined;
    let largeSize: number | undefined;
    let expectedLiveDataSize: number | undefined;

    function callbackGenerator(fn: any): void {
      for (const gcEvent of gcEvents) {
        fn(gcEvent);

        const oldAfter = gcEvent.after.heapSpaceStats[2].spaceUsedSize;
        if (gcEvent.type === "markSweepCompact") {
          expectedLiveDataSize = oldAfter;
        }

        const expectedPromotionRate = oldAfter - gcEvent.before.heapSpaceStats[2].spaceUsedSize;
        const youngAfter = gcEvent.after.heapSpaceStats[1].spaceUsedSize;
        const youngBefore = gcEvent.before.heapSpaceStats[1].spaceUsedSize;
        let expectedAllocationRate = youngAfter < youngBefore ? youngBefore - youngAfter : 0;

        // see if we allocated something in map or large
        const beforeMap = gcEvent.before.heapSpaceStats[4].spaceUsedSize;
        const beforeLarge = gcEvent.before.heapSpaceStats[5].spaceUsedSize;
        const afterMap = gcEvent.after.heapSpaceStats[4].spaceUsedSize;
        const afterLarge = gcEvent.after.heapSpaceStats[5].spaceUsedSize;
        if (mapSize && mapSize < beforeMap) {
          expectedAllocationRate += beforeMap - mapSize;
        }
        mapSize = afterMap;
        if (largeSize && largeSize < beforeLarge) {
          expectedAllocationRate += beforeLarge - largeSize;
        }
        largeSize = afterLarge;

        for (const line of writer.get()) {
          const [, id, value] = parse_protocol_line(line);

          assert.equal(id.tags()["nodejs.version"], process.version);

          if (id.name() === "nodejs.gc.maxDataSize") {
            assert.equal(parseFloat(value), 1526909922, "maxDataSize does not match");
          } else if (id.name() === "nodejs.gc.liveDataSize") {
            assert.equal(parseFloat(value), expectedLiveDataSize, "liveDataSize does not match");
          } else if (id.name() === "nodejs.gc.promotionRate") {
            assert.equal(parseFloat(value), expectedPromotionRate, "promotionRate does not match");
          } else if (id.name() === "nodejs.gc.allocationRate") {
            assert.equal(parseFloat(value), expectedAllocationRate, "allocationRate does not match");
          } else if (id.name() === "nodejs.gc.pause") {
            assert.equal(parseFloat(value), gcEvent.elapsed, "pause does not match");
          } else if (id.name() !== "nodejs.gc.pause") {
            assert.fail(`Unexpected protocol line: ${line}`);
          }
        }

        writer.clear();
      }
    }

    metrics.measureGcEvents(callbackGenerator);

    Object.defineProperty(process, "hrtime", f);
  });

  it("should collect fd metrics", (): void => {
    const r = new Registry(new Config("memory"));
    const writer = r.writer() as MemoryWriter;
    const metrics = new RuntimeMetrics(r);

    function assertFd(open: number, max?: number): void {
      for (const line of writer.get()) {
        const [, id, value] = parse_protocol_line(line);
        if (id.name() === "openFileDescriptorsCount") {
          assert.equal(parseFloat(value), open, "openFileDescriptorsCount does not match");
        } else if (id.name() === "maxFileDescriptorsCount") {
          assert.equal(parseFloat(value), max, "maxFileDescriptorsCount does not match");
        } else {
          assert.fail(`Unexpected protocol line: ${line}`);
        }
      }
      writer.clear();
    }

    RuntimeMetrics.measureFdActivity(metrics, (): {used: number, max: number} => {
      return {used: 42, max: 32768};
    });
    assertFd(42, 32768);

    RuntimeMetrics.measureFdActivity(metrics, (): {used: number, max: number} => {
      return {used: 1, max: 1024};
    });
    assertFd(1, 1024);

    // test max == null (which should not produce a metric)
    RuntimeMetrics.measureFdActivity(metrics, (): {used: number, max: null} => {
      return {used: 1, max: null};
    });
    assertFd(1);
  });

  it("should collect event loop lag time", (): void => {
    const r = new Registry(new Config("memory"));
    const writer = r.writer() as MemoryWriter;
    const metrics = new RuntimeMetrics(r);

    let nanos: number = 0;
    let round: number = 1;
    const f: NodeJS.HRTime = process.hrtime;
    Object.defineProperty(process, "hrtime", {
      get(): () => [number, number] {
        return (): [number, number] => {
          // add 1 second to account for the schedule period of 1 second
          nanos += 1e9 + round * 1e6;  // 1ms lag first time, 2ms second time, etc.
          ++round;
          return [0, nanos];
        };
      }
    });

    function assertLag(expected: number): void {
      assert.equal(writer.get().length, 1);
      const [, id, value] = parse_protocol_line(writer.get()[0]);
      assert.equal(id.name(), "nodejs.eventLoopLag");
      assert.equal(id.tags()["nodejs.version"], process.version);
      assert.closeTo(parseFloat(value), expected, 1e-6);
      writer.clear();
    }

    RuntimeMetrics.measureEventLoopLag(metrics);
    assertLag(0.001);

    RuntimeMetrics.measureEventLoopLag(metrics);
    assertLag(0.002);

    RuntimeMetrics.measureEventLoopLag(metrics);
    assertLag(0.003);

    Object.defineProperty(process, "hrtime", f);
  });

  it("should collect eventLoopUtilization metrics when possible", (): void => {
    const r = new Registry(new Config("memory"));
    const writer = r.writer() as MemoryWriter;
    const metrics = new RuntimeMetrics(r);

    function assertUtil(expected: number): void {
      assert.equal(writer.get().length, 1);
      const [, id, value] = parse_protocol_line(writer.get()[0]);
      assert.equal(id.name(), "nodejs.eventLoopUtilization");
      assert.equal(id.tags()["nodejs.version"], process.version);
      assert.closeTo(parseFloat(value), expected, 1e-6);
      writer.clear();
    }

    metrics.lastEventLoopTime = [0, 0];
    metrics.lastEventLoop = {
      idle: 0,
      active: 0,
      utilization: 0
    };

    // 3s elapsed, 2 active 1 idle
    const elu = {
      idle: 1000,
      active: 2000,
      utilization: 2.0 / 3.0
    };
    metrics.eventLoopUtilization = () => {
      return Object.assign({}, elu);
    };

    const f: NodeJS.HRTime = process.hrtime;
    let seconds: number = 3;
    Object.defineProperty(process, "hrtime", {
      get(): () => [number, number] {
        return (): [number, number] => {
          return [seconds, 0];
        };
      }
    });

    RuntimeMetrics.measureEventLoopUtilization(metrics);
    assertUtil(200 / 3.0);

    // 5s, 1s active, 4s idle
    seconds += 5;
    elu.idle += 4000;
    elu.active += 1000;
    elu.utilization = 1 / 5.0;

    RuntimeMetrics.measureEventLoopUtilization(metrics);
    assertUtil(100 / 5.0);

    Object.defineProperty(process, "hrtime", f);
  });

  it("should provide a way to check whether it has started", (): void => {
    const r = new Registry(new Config("memory"));
    const metrics = new RuntimeMetrics(r);

    assert.isFalse(metrics.started);
    metrics.start();
    assert.isTrue(metrics.started);

    metrics.start();  // does nothing
    assert.isTrue(metrics.started);

    metrics.stop();
    assert.isFalse(metrics.started);
  });
});
