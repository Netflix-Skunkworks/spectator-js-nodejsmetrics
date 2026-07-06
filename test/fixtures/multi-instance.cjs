// Two RuntimeMetrics instances registering GC callbacks on the same isolate must both
// keep emitting (fan-out), not last-writer-wins. `forceGc` comes from _prelude.cjs.
const { RuntimeMetrics } = require('.');
const { Config, Registry } = require('nflx-spectator');
const registry = new Registry(new Config('memory'));
const writer = registry.writer();
new RuntimeMetrics(registry).start();
new RuntimeMetrics(registry).start();

setImmediate(() => {
  forceGc();
  setImmediate(() => {
    const lines = writer.get();
    if (!lines.some((line) => line.includes('nodejs.gc.'))) {
      console.error('expected at least one nodejs.gc.* metric, saw:', lines.join('\n'));
      process.exit(2);
    }
    console.log('gc metrics emitted');
  });
});
