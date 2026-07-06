// start() -> stop() -> start() must re-register the native GC callbacks and resume emission.
// `forceGc` and `tick` come from _prelude.cjs.
const { RuntimeMetrics } = require('.');
const { Config, Registry } = require('nflx-spectator');
const registry = new Registry(new Config('memory'));
const writer = registry.writer();
const metrics = new RuntimeMetrics(registry);

async function assertGcMetrics(label) {
  forceGc();
  await tick();
  await tick();
  const lines = writer.get().filter((line) => line.includes('nodejs.gc.'));
  if (lines.length === 0) {
    console.error('expected gc metrics ' + label + ', saw:', writer.get().join('\n'));
    process.exit(2);
  }
  writer.clear();
}

(async () => {
  metrics.start();
  await assertGcMetrics('before stop');
  metrics.stop();
  metrics.start();
  await assertGcMetrics('after restart');
  metrics.stop();
  console.log('gc metrics restarted');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(4);
});
