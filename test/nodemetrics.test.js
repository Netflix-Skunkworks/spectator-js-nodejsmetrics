'use strict';

const fs = require('fs');
const spectator = require('nflx-spectator');
const NodeMetrics = require('../');
const assert = require('chai').assert;

describe('nodemetrics', () => {
  it('should not prevent node from exiting', () => {
    // basic test to make sure `start()` with no `stop()`
    // does not prevent the mocha from exiting
    const registry = new spectator.Registry({strictMode: true, gaugePollingFrequency: 1});
    const metrics = new NodeMetrics(registry);
    metrics.start();
  });

  it('should generate a few meters', (done) => {
    // basic test to make sure `start()` actually starts the
    // collection
    const registry = new spectator.Registry({strictMode: true, gaugePollingFrequency: 1});
    const metrics = new NodeMetrics(registry);
    metrics.start();

    setTimeout(() => {
      const meters = registry.meters();
      assert.isTrue(meters.length > 40);
      metrics.stop();
      done();
    });
  });

  // ensures a timer with a count of one was correctly generated
  function assertTimer(timer, elapsedTime) {
    const v = elapsedTime;
    assert.isTrue(Math.abs(timer.totalTime - v) < 1e-9, `Expected ${timer.totalTime} to be ${v}`);
    assert.isTrue(Math.abs(timer.totalOfSquares - v * v) < 1e-9);
    assert.isTrue(Math.abs(timer.max - v) < 1e-9);
    assert.equal(timer.count, 1);
  }

  // filters the measurements to find the timer values for a given name
  // makes sure there's only one id tag for that name
  function getTimer(measurements, timerName) {
    const timer = {};
    let id;
    for (let m of measurements) {
      if (m.id.name === timerName) {
        timer[m.id.tags.get('statistic')] = m.v;
        const thisId = m.id.tags.get('id');
        if (!id) {
          id = thisId;
        } else {
          // ensure there's only one id for the timerName
          assert.equal(id, thisId);
        }
      }
    }

    return timer;
  }

  it('should collect gc metrics', () => {
    const gcEvents = JSON.parse(fs.readFileSync('test/resources/gc-events.json'));

    const registry = new spectator.Registry({strictMode: true, gaugePollingFrequency: 1});
    let nanos = 0;
    registry.hrtime = () => {
      nanos += 1e6;
      return [0, nanos];
    };

    const metrics = new NodeMetrics(registry);

    let mapSize;
    let largeSize;

    function callbackGenerator(f) {
      for (let gcEvt of gcEvents) {
        f(gcEvt);
        const ms = registry.measurements();
        let expectedLiveDataSize;
        const oldAfter = gcEvt.after.heapSpaceStats[2].spaceUsedSize;
        if (gcEvt.type === 'markSweepCompact') {
          expectedLiveDataSize = oldAfter;
        }
        const expectedPromotionRate = oldAfter - gcEvt.before.heapSpaceStats[2].spaceUsedSize;
        const youngAfter = gcEvt.after.heapSpaceStats[1].spaceUsedSize;
        const youngBefore = gcEvt.before.heapSpaceStats[1].spaceUsedSize;
        let expectedAllocationRate = youngAfter < youngBefore ? youngBefore - youngAfter : 0;
        // see if we allocated something in map or large
        const beforeMap = gcEvt.before.heapSpaceStats[4].spaceUsedSize;
        const beforeLarge = gcEvt.before.heapSpaceStats[5].spaceUsedSize;
        const afterMap = gcEvt.after.heapSpaceStats[4].spaceUsedSize;
        const afterLarge = gcEvt.after.heapSpaceStats[5].spaceUsedSize;
        if (mapSize && mapSize < beforeMap) {
          expectedAllocationRate += beforeMap - mapSize;
        }
        mapSize = afterMap;
        if (largeSize && largeSize < beforeLarge) {
          expectedAllocationRate += beforeLarge - largeSize;
        }
        largeSize = afterLarge;
        for (let m of ms) {
          assert.equal(m.id.tags.get('nodejs.version'), process.version);
          if (m.id.name === 'nodejs.gc.maxDataSize') {
            assert.equal(m.v, 1526909922);
          } else if (m.id.name === 'nodejs.gc.liveDataSize') {
            assert.equal(m.v, expectedLiveDataSize);
          } else if (m.id.name === 'nodejs.gc.promotionRate') {
            assert.equal(m.v, expectedPromotionRate);
          } else if (m.id.name === 'nodejs.gc.allocationRate') {
            assert.equal(m.v, expectedAllocationRate);
          } else if (m.id.name !== 'nodejs.gc.pause') {
            assert.fail(`Unexpected measurement generated: ${m.id.key}=${m.v}`);
          }
        }
        const gcPauseTimer = getTimer(ms, 'nodejs.gc.pause');
        assertTimer(gcPauseTimer, gcEvt.elapsed);
      }
    }

    metrics._gcEvents(callbackGenerator);
  });

  it('should collect fd metrics', () => {
    const registry = new spectator.Registry({strictMode: true, gaugePollingFrequency: 1});
    const metrics = new NodeMetrics(registry);

    function assertFd(measurements, open, max) {
      for (let m of registry.measurements()) {
        if (m.id.name === 'openFileDescriptorsCount') {
          assert.equal(m.v, open);
        } else if (m.id.name === 'maxFileDescriptorsCount') {
          assert.equal(m.v, max);
        } else {
          assert.fail(`Unexpected measurement: ${m.id.key}=${m.v}`);
        }
      }
    }

    NodeMetrics.updateFdGauges(metrics, () => {
      return {used: 42, max: 32768};
    });
    assertFd(registry.measurements(), 42, 32768);

    NodeMetrics.updateFdGauges(metrics, () => {
      return {used: 1, max: 1024};
    });
    assertFd(registry.measurements(), 1, 1024);

    // test max == null (which shouldn't produce a metric)
    NodeMetrics.updateFdGauges(metrics, () => {
      return {used: 1, max: null};
    });
    assertFd(registry.measurements(), 1);
  });

  it('should collect evt loop lag time', () => {
    const registry = new spectator.Registry({strictMode: true, gaugePollingFrequency: 1});
    const metrics = new NodeMetrics(registry);

    let nanos = 0;
    let round = 1;
    registry.hrtime = () => {
      nanos += 1e9 + round * 1e6; // 1ms lag first time, 2ms second time, etc.
      ++round;
      return [0, nanos];
    };

    metrics._lastNanos = 0;

    NodeMetrics.updateEvtLoopLag(metrics);
    const timer = metrics.evtLoopLagTimer;
    let t = timer.totalTime / 1e9;
    assert.closeTo(t, 0.001, 1e-6);
    assert.equal(timer.count, 1);

    NodeMetrics.updateEvtLoopLag(metrics);
    t = timer.totalTime / 1e9;
    assert.closeTo(t, 0.003, 1e-6); // 1ms + 2ms
    assert.equal(timer.count, 2);

    timer.measure(); // reset
    NodeMetrics.updateEvtLoopLag(metrics);
    t = timer.totalTime / 1e9;
    assert.closeTo(t, 0.003, 1e-6);
    assert.equal(timer.count, 1);
  });

  it('should collect eventLoopUtilization metrics when possible', () => {

    const registry = new spectator.Registry({strictMode: true, gaugePollingFrequency: 1});
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

    let seconds = 3;
    registry.hrtime = () => {
      return [seconds, 0];
    };

    NodeMetrics.measureEvtLoopUtilization(metrics);

    const active = metrics.eventLoopActive;
    assert.closeTo(active.get(), 200 / 3.0, 1e-6);

    // 5s, 1s active, 4s idle
    seconds += 5;
    elu.idle += 4000;
    elu.active += 1000;
    elu.utilization = 1 / 5.0;
    NodeMetrics.measureEvtLoopUtilization(metrics);
    assert.closeTo(active.get(), 100 / 5.0, 1e-6);
  });

  it('should provide a way to check whether it has started', () => {
    const registry = new spectator.Registry({strictMode: true, gaugePollingFrequency: 1});
    const metrics = new NodeMetrics(registry);

    assert.isFalse(metrics.started);
    metrics.start();
    assert.isTrue(metrics.started);
    // should do nothing
    metrics.start();
    assert.isTrue(metrics.started);
    metrics.stop();
    assert.isFalse(metrics.started);
  });
});
