// Accuracy harness: drives RuntimeMetrics against the LIVE runtime and cross-checks each
// recorded metric against an INDEPENDENT ground-truth source (a second read, /proc, ulimit,
// an induced condition). Unlike the unit tests -- which stub the sources -- this proves the
// emitted numbers match reality end to end.
//
// Run:  npm run example        (builds first, then runs this)
//   or: node examples/verify-accuracy.mjs   (requires `npm run build` first)
//
// No --expose-gc needed: GC is forced via the v8.setFlagsFromString + vm trick below.

import v8 from "node:v8";
import fs from "node:fs";
import vm from "node:vm";
import {execSync} from "node:child_process";
import {Config, Registry, parse_protocol_line} from "nflx-spectator";
import {RuntimeMetrics} from "../esm/src/index.js";
import {GcEventSource} from "../esm/src/gc.js";
import {collectFdStats} from "../esm/src/fd.js";

let passed = 0;
let failed = 0;

function ok(cond, label, detail) {
  console.log(`  ${cond ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${label}${detail ? `  —  ${detail}` : ""}`);
  cond ? ++passed : ++failed;
}
function info(label, detail) {
  console.log(`  \x1b[36mINFO\x1b[0m  ${label}${detail ? `  —  ${detail}` : ""}`);
}
function mb(n) { return `${(n / 1048576).toFixed(2)}MB`; }
function camel(s) { return s.replace(/_([a-z])/g, (g) => g[1].toUpperCase()); }

// Read the MemoryWriter's emitted lines into a map keyed by "<name>|<id-tag>".
function meters(writer) {
  const m = new Map();
  for (const line of writer.get()) {
    const [, id, value] = parse_protocol_line(line);
    m.set(`${id.name()}|${id.tags()["id"] ?? ""}`, parseFloat(value));
  }
  return m;
}
// Sum every recorded value for a meter name (counters emit one line per increment).
function sumOf(writer, name) {
  let sum = 0;
  for (const line of writer.get()) {
    const [, id, value] = parse_protocol_line(line);
    if (id.name() === name) sum += parseFloat(value);
  }
  return sum;
}
function getGc() {
  if (typeof globalThis.gc === "function") return globalThis.gc;
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc");
}
function busyWaitMs(ms) {
  const end = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
  while (process.hrtime.bigint() < end) { /* block the event loop */ }
}

const registry = new Registry(new Config("memory"));
const writer = registry.writer();
const metrics = new RuntimeMetrics(registry);

// ---------------------------------------------------------------------------
console.log("\n=== 1. Memory & V8 heap  (recorded vs a fresh process.memoryUsage / v8.getHeapStatistics) ===");
RuntimeMetrics.measureCpuHeap(metrics);           // baseline call (primes the cpu-usage delta)
writer.clear();
const memBefore = process.memoryUsage();
const heapTruth = v8.getHeapStatistics();
RuntimeMetrics.measureCpuHeap(metrics);           // this is the sample we inspect
const memAfter = process.memoryUsage();
const m1 = meters(writer);

// process.memoryUsage() pass-throughs: the recorded value must sit between two real reads
// taken immediately before and after the sample (heap moves a little between reads).
for (const key of ["rss", "heapTotal", "heapUsed", "external"]) {
  const rec = m1.get(`nodejs.${key}|`);
  const lo = Math.min(memBefore[key], memAfter[key]) - 4 * 1048576;   // 4MB slack
  const hi = Math.max(memBefore[key], memAfter[key]) + 4 * 1048576;
  ok(rec >= lo && rec <= hi, `nodejs.${key}`, `recorded=${mb(rec)}  live≈${mb(memBefore[key])}..${mb(memAfter[key])}`);
}
// heap_size_limit is stable across reads -> must match exactly.
ok(m1.get("nodejs.heapSizeLimit|") === heapTruth.heap_size_limit,
  "nodejs.heapSizeLimit (stable, exact)", `recorded=${m1.get("nodejs.heapSizeLimit|")}  truth=${heapTruth.heap_size_limit}`);
// invariant that must always hold
ok(m1.get("nodejs.usedHeapSize|") <= m1.get("nodejs.totalHeapSize|"),
  "usedHeapSize <= totalHeapSize", `${mb(m1.get("nodejs.usedHeapSize|"))} <= ${mb(m1.get("nodejs.totalHeapSize|"))}`);

// ---------------------------------------------------------------------------
console.log("\n=== 2. File descriptors  (recorded vs /proc count and `ulimit -n`) ===");
writer.clear();
const N = 25;
const fds = [];
try {
  for (let i = 0; i < N; ++i) fds.push(fs.openSync(process.execPath, "r"));
  RuntimeMetrics.measureFdActivity(metrics, collectFdStats);
  const m2 = meters(writer);
  const recUsed = m2.get("openFileDescriptorsCount|");
  const recMax = m2.get("maxFileDescriptorsCount|");

  if (process.platform === "linux") {
    const trueUsed = fs.readdirSync("/proc/self/fd").length;   // independent count
    ok(Math.abs(recUsed - trueUsed) <= 2, "openFileDescriptorsCount", `recorded=${recUsed}  /proc count=${trueUsed}`);
  } else {
    ok(recUsed === 0, "openFileDescriptorsCount (macOS: 0, no /proc — by design)", `recorded=${recUsed}`);
  }

  let ulimitN = NaN;
  try { ulimitN = parseInt(execSync("ulimit -n", {encoding: "utf8"}).trim(), 10); } catch { /* ignore */ }
  if (Number.isFinite(ulimitN)) {
    ok(recMax === ulimitN, "maxFileDescriptorsCount == `ulimit -n`", `recorded=${recMax}  ulimit=${ulimitN}`);
  } else {
    info("maxFileDescriptorsCount (ulimit unlimited/unavailable)", `recorded=${recMax}`);
  }
} finally {
  for (const fd of fds) fs.closeSync(fd);
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. Event-loop lag  (induced: block the loop a known amount) ===");
writer.clear();
const BLOCK_MS = 1200;                              // the metric subtracts the 1000ms nominal schedule
const now = process.hrtime();
metrics.lastNanos = now[0] * 1e9 + now[1];          // pretend the 1s lag timer just fired
busyWaitMs(BLOCK_MS);                               // <-- a real blocked event loop
RuntimeMetrics.measureEventLoopLag(metrics);
const recLagSec = meters(writer).get("nodejs.eventLoopLag|");
const expectedLagSec = (BLOCK_MS - 1000) / 1000;    // 0.200s
ok(Math.abs(recLagSec - expectedLagSec) < 0.03, "nodejs.eventLoopLag reflects the induced block",
  `recorded=${(recLagSec * 1000).toFixed(1)}ms  induced≈${(expectedLagSec * 1000).toFixed(0)}ms`);

// ---------------------------------------------------------------------------
console.log("\n=== 4. GC metrics  (recorded vs the exact transform of real GC events) ===");
const gc = getGc();
const events = [];
const src = new GcEventSource();
src.start((e) => events.push(e));

// Generate garbage (drives allocationRate) and retain data (forces promotion to old_space).
const retained = [];
for (let round = 0; round < 30; ++round) {
  const chunk = [];
  for (let i = 0; i < 20000; ++i) chunk.push({i, s: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"});
  retained.push(chunk.slice(0, 4000));              // keep a slice -> promoted
  gc();
}
gc(); gc();
src.drain();
src.stop();

ok(events.length > 0, "captured live GC events", `count=${events.length}`);

const heapLimit = v8.getHeapStatistics().heap_size_limit;
const oldUsed = (snap) => (snap.heapSpaceStats.find((s) => s.spaceName === "old_space")?.spaceUsedSize ?? 0);

// Feed each real event through the library and confirm each meter equals the exact transform.
let pauseExact = true;
let maxExact = true;
let expectedPromotion = 0;
for (const e of events) {
  writer.clear();
  metrics.recordGcEvent(e);
  const mm = meters(writer);
  if (mm.get("nodejs.gc.maxDataSize|") !== e.after.heapSizeLimit) maxExact = false;
  const pause = mm.get(`nodejs.gc.pause|${e.type}`);
  if (pause === undefined || Math.abs(pause - e.elapsed) > 1e-9) pauseExact = false;
  const delta = oldUsed(e.after) - oldUsed(e.before);
  if (delta > 0) expectedPromotion += delta;
}
ok(maxExact, "nodejs.gc.maxDataSize == event.after.heapSizeLimit (every event)");
ok(events.every((e) => e.after.heapSizeLimit === heapLimit), "event.after.heapSizeLimit == v8 heap_size_limit");
ok(pauseExact, "nodejs.gc.pause == event.elapsed (every event)");

// Exact accuracy check on real data: total promotionRate == Σ positive old_space growth.
const promoReg = new Registry(new Config("memory"));
const promoWriter = promoReg.writer();
const promoMetrics = new RuntimeMetrics(promoReg);
for (const e of events) promoMetrics.recordGcEvent(e);
const recordedPromotion = sumOf(promoWriter, "nodejs.gc.promotionRate");
const recordedAllocation = sumOf(promoWriter, "nodejs.gc.allocationRate");
ok(recordedPromotion === expectedPromotion,
  "Σ nodejs.gc.promotionRate == Σ max(0, old_space after-before)", `recorded=${recordedPromotion}  expected=${expectedPromotion}`);
ok(recordedAllocation > 0, "nodejs.gc.allocationRate > 0 after generating garbage", `total=${recordedAllocation} bytes`);

// ---------------------------------------------------------------------------
console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
