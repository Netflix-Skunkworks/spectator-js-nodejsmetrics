// Worker-thread body: runs in its own V8 isolate. `forceGc` is provided by _prelude.cjs,
// which worker-isolates-main.cjs prepends before evaluating this in each Worker.
const { parentPort } = require('worker_threads');
const { RuntimeMetrics } = require('.');
const { Config, Registry } = require('nflx-spectator');
const registry = new Registry(new Config('memory'));
const writer = registry.writer();
new RuntimeMetrics(registry).start();

setImmediate(() => {
  forceGc(10);
  setImmediate(() => {
    const lines = writer.get();
    if (!lines.some((line) => line.includes('nodejs.gc.'))) {
      throw new Error('expected at least one nodejs.gc.* metric, saw: ' + lines.join('\n'));
    }
    parentPort.postMessage('gc metrics emitted');
  });
});
