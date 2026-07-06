// stop() must halt native GC emission: metrics appear before stop() and none after.
// `forceGc` and `tick` come from _prelude.cjs.
const { RuntimeMetrics } = require('.');
const { Config, Registry } = require('nflx-spectator');
const registry = new Registry(new Config('memory'));
const writer = registry.writer();
const metrics = new RuntimeMetrics(registry);

function gcLines() {
  return writer.get().filter((line) => line.includes('nodejs.gc.'));
}

(async () => {
  metrics.start();
  forceGc();
  await tick();
  await tick();

  if (gcLines().length === 0) {
    console.error('expected gc metrics before stop, saw:', writer.get().join('\n'));
    process.exit(2);
  }

  writer.clear();
  metrics.stop();
  forceGc();
  await tick();
  await tick();

  const lines = gcLines();
  if (lines.length !== 0) {
    console.error('expected no gc metrics after stop, saw:', lines.join('\n'));
    process.exit(3);
  }

  console.log('gc metrics stopped');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(4);
});
