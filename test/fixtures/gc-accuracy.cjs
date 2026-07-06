// Validates the NATIVE GC heap capture via the raw internals.EmitGCEvents callback.
// Asserts the captured event's before/after snapshots are internally CONSISTENT and
// agree with node:v8 on stable/structural facts (heap_size_limit, heap-space name set),
// rather than comparing volatile counters sampled at different instants.
// `forceGc`/`tick` come from _prelude.cjs.
const internals = require('./build/Release/spectator_internals.node');
const v8 = require('node:v8');

const KNOWN_TYPES = new Set([
  'scavenge',
  'markSweepCompact',
  'incrementalMarking',
  'processWeakCallbacks',
]);

function fail(msg, extra) {
  console.error('gc-accuracy assertion failed:', msg, extra !== undefined ? extra : '');
  process.exit(2);
}

function checkSnapshot(label, snap, expectedSpaceNames, stableLimit) {
  if (!snap || typeof snap !== 'object') fail(`${label} missing`, snap);

  // heapSizeLimit > 0 and ~equals the stable v8 heap_size_limit.
  if (!(snap.heapSizeLimit > 0)) fail(`${label}.heapSizeLimit not > 0`, snap.heapSizeLimit);
  if (snap.heapSizeLimit !== stableLimit) {
    fail(`${label}.heapSizeLimit != v8 heap_size_limit`, `${snap.heapSizeLimit} vs ${stableLimit}`);
  }

  // usedHeapSize <= totalHeapSize.
  if (!(snap.usedHeapSize <= snap.totalHeapSize)) {
    fail(`${label} usedHeapSize > totalHeapSize`, `${snap.usedHeapSize} > ${snap.totalHeapSize}`);
  }

  // totalPhysicalSize >= 0.
  if (!(snap.totalPhysicalSize >= 0)) fail(`${label}.totalPhysicalSize < 0`, snap.totalPhysicalSize);

  // heapSpaceStats present with the exact same SET of space names v8 reports (ABI/index drift).
  if (!Array.isArray(snap.heapSpaceStats)) fail(`${label}.heapSpaceStats not array`, snap.heapSpaceStats);
  const names = new Set(snap.heapSpaceStats.map((s) => s.spaceName));
  if (names.size !== expectedSpaceNames.size) {
    fail(`${label} heap space name-set size mismatch`, `${[...names]} vs ${[...expectedSpaceNames]}`);
  }
  for (const n of expectedSpaceNames) {
    if (!names.has(n)) fail(`${label} missing heap space`, n);
  }

  // Every space: spaceUsedSize <= spaceSize.
  for (const s of snap.heapSpaceStats) {
    if (!(s.spaceUsedSize <= s.spaceSize)) {
      fail(`${label} space ${s.spaceName} used > size`, `${s.spaceUsedSize} > ${s.spaceSize}`);
    }
  }
}

async function main() {
  const stableLimit = v8.getHeapStatistics().heap_size_limit;
  const expectedSpaceNames = new Set(v8.getHeapSpaceStatistics().map((s) => s.space_name));

  const captured = [];
  const cb = (event) => { captured.push(event); };
  internals.EmitGCEvents(cb);

  // Force real GCs, then let the uv_async deliver events (two ticks to be safe).
  forceGc();
  await tick();
  await tick();

  internals.DisableGCEvents(cb);

  if (captured.length === 0) fail('no GC events captured');

  const event = captured[0];

  // event.type is one of the known strings.
  if (!KNOWN_TYPES.has(event.type)) fail('unknown event.type', event.type);

  // event.elapsed >= 0 and finite.
  if (!Number.isFinite(event.elapsed)) fail('event.elapsed not finite', event.elapsed);
  if (!(event.elapsed >= 0)) fail('event.elapsed < 0', event.elapsed);

  checkSnapshot('before', event.before, expectedSpaceNames, stableLimit);
  checkSnapshot('after', event.after, expectedSpaceNames, stableLimit);

  // Cross-check: drive the public RuntimeMetrics and confirm nodejs.gc.maxDataSize == v8 heap_size_limit.
  const { RuntimeMetrics } = require('.');
  const { Config, Registry } = require('nflx-spectator');
  const registry = new Registry(new Config('memory'));
  const writer = registry.writer();
  const rm = new RuntimeMetrics(registry);
  rm.start();

  forceGc();
  await tick();
  await tick();

  const lines = writer.get();
  const maxLine = lines.find((l) => l.includes('nodejs.gc.maxDataSize'));
  if (!maxLine) {
    fail('no nodejs.gc.maxDataSize line emitted', lines.join('\n'));
  }
  // Protocol line looks like: g:nodejs.gc.maxDataSize,<tags>:<value>
  const value = parseFloat(maxLine.slice(maxLine.lastIndexOf(':') + 1));
  if (value !== stableLimit) {
    fail('nodejs.gc.maxDataSize != v8 heap_size_limit', `${value} vs ${stableLimit}`);
  }

  rm.stop();

  console.log('GC_ACCURACY_OK');
}

main().catch((e) => {
  console.error('gc-accuracy threw:', e && e.stack ? e.stack : e);
  process.exit(3);
});
