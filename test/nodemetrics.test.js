const fs = require("fs");
const spectator = require("nflx-spectator");
const NodeMetrics = require("../");
const assert = require("chai").assert;

describe("nodemetrics", () => {

  it("should not prevent node from exiting", () => {
    // ensure `start()` with no `stop()` does not prevent mocha from exiting
    const config = new spectator.Config("memory");
    const registry = new spectator.Registry(config);
    const metrics = new NodeMetrics(registry);
    metrics.start();
  });

  it("should generate a few meters", (done) => {
    // ensure `start()` actually starts the collection
    const config = new spectator.Config("memory");
    const registry = new spectator.Registry(config);
    const metrics = new NodeMetrics(registry);
    metrics.start();

    setTimeout(() => {
      // locally, we can see 3-12 values, mostly 3
      assert.isTrue(registry.writer().get().length >= 3);
      metrics.stop();
      done();
    }, 2);
  });

  it("should collect gc metrics", () => {
    const gcEvents = JSON.parse(fs.readFileSync("test/resources/gc-events.json").toString());

    const config = new spectator.Config("memory");
    const registry = new spectator.Registry(config);

    let nanos = 0;
    const f = process.hrtime;
    process.hrtime = () => {
      nanos += 1e6;
      return [0, nanos];
    };

    const metrics = new NodeMetrics(registry);

    let mapSize;
    let largeSize;
    let expectedLiveDataSize;

    function callbackGenerator(fn) {
      for (let gcEvent of gcEvents) {
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

        for (let line of registry.writer().get()) {
          const [, id, value] = spectator.parse_protocol_line(line);

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
        registry.writer().clear();
      }
    }

    metrics._gcEvents(callbackGenerator);

    process.hrtime = f;
  });

  it("should collect fd metrics", () => {
    const config = new spectator.Config("memory");
    const registry = new spectator.Registry(config);
    const metrics = new NodeMetrics(registry);

    function assertFd(open, max) {
      for (let line of registry.writer().get()) {
        const [, id, value] = spectator.parse_protocol_line(line);
        if (id.name() === "openFileDescriptorsCount") {
          assert.equal(value, open, "openFileDescriptorsCount does not match");
        } else if (id.name() === "maxFileDescriptorsCount") {
          assert.equal(value, max, "maxFileDescriptorsCount does not match");
        } else {
          assert.fail(`Unexpected protocol line: ${line}`);
        }
      }
      registry.writer().clear();
    }

    NodeMetrics.updateFdGauges(metrics, () => {
      return {used: 42, max: 32768};
    });
    assertFd(42, 32768);

    NodeMetrics.updateFdGauges(metrics, () => {
      return {used: 1, max: 1024};
    });
    assertFd(1, 1024);

    // test max == null (which shouldn't produce a metric)
    NodeMetrics.updateFdGauges(metrics, () => {
      return {used: 1, max: null};
    });
    assertFd(1);
  });

  it("should collect event loop lag time", () => {
    const config = new spectator.Config("memory");
    const registry = new spectator.Registry(config);
    const metrics = new NodeMetrics(registry);

    let nanos = 0;
    let round = 1;
    const f = process.hrtime;
    process.hrtime = () => {
      nanos += 1e9 + round * 1e6;  // 1ms lag first time, 2ms second time, etc.
      ++round;
      return [0, nanos];
    };

    metrics._lastNanos = 0;

    NodeMetrics.updateEventLoopLag(metrics);
    assert.equal(registry.writer().get().length, 1);
    let [, id, value] = spectator.parse_protocol_line(registry.writer().get()[0]);
    assert.equal(id.name(), "nodejs.eventLoopLag");
    assert.equal(id.tags()["nodejs.version"], process.version);
    assert.closeTo(parseFloat(value), 0.001, 1e-6);
    registry.writer().clear();

    NodeMetrics.updateEventLoopLag(metrics);
    assert.equal(registry.writer().get().length, 1);
    [, , value] = spectator.parse_protocol_line(registry.writer().get()[0]);
    assert.closeTo(parseFloat(value), 0.002, 1e-6);
    registry.writer().clear();

    NodeMetrics.updateEventLoopLag(metrics);
    assert.equal(registry.writer().get().length, 1);
    [, , value] = spectator.parse_protocol_line(registry.writer().get()[0]);
    assert.closeTo(parseFloat(value), 0.003, 1e-6);
    registry.writer().clear();

    process.hrtime = f;
  });

  it("should collect eventLoopUtilization metrics when possible", () => {
    const config = new spectator.Config("memory");
    const registry = new spectator.Registry(config);

    const metrics = new NodeMetrics(registry);
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

    const f = process.hrtime;
    let seconds = 3;
    process.hrtime = () => {
      return [seconds, 0];
    };

    NodeMetrics.measureEventLoopUtilization(metrics);
    assert.equal(registry.writer().get().length, 1);
    let [, id, value] = spectator.parse_protocol_line(registry.writer().get()[0]);
    assert.equal(id.name(), "nodejs.eventLoopUtilization");
    assert.equal(id.tags()["nodejs.version"], process.version);
    assert.closeTo(parseFloat(value), 200 / 3.0, 1e-6);
    registry.writer().clear();

    // 5s, 1s active, 4s idle
    seconds += 5;
    elu.idle += 4000;
    elu.active += 1000;
    elu.utilization = 1 / 5.0;

    NodeMetrics.measureEventLoopUtilization(metrics);
    assert.equal(registry.writer().get().length, 1);
    [, , value] = spectator.parse_protocol_line(registry.writer().get()[0]);
    assert.closeTo(parseFloat(value), 100 / 5.0, 1e-6);

    process.hrtime = f;
  });

  it("should provide a way to check whether it has started", () => {
    const config = new spectator.Config("memory");
    const registry = new spectator.Registry(config);
    const metrics = new NodeMetrics(registry);

    assert.isFalse(metrics.started);
    metrics.start();
    assert.isTrue(metrics.started);

    metrics.start();  // does nothing
    assert.isTrue(metrics.started);

    metrics.stop();
    assert.isFalse(metrics.started);
  });
});
