import fs from "node:fs";
import {Config, MemoryWriter, parse_protocol_line, Registry} from "nflx-spectator";
import {assert} from "chai";
import {RuntimeMetrics} from "../src/index.js"
import {describe, it} from "node:test";

describe("nodemetrics", (): void => {

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve: (value: void | PromiseLike<void>) => void): void => {
      setTimeout(resolve, ms);
    });
  }

  it("should not prevent node from exiting", (): void => {
    // ensure `start()` with no `stop()` does not prevent mocha from exiting
    const r = new Registry(new Config("memory"));
    const metrics = new RuntimeMetrics(r);
    metrics.start();
  });

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
          nanos += round * 1e6;  // 1ms lag first time, 2ms second time, etc.
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
