// Spawns several worker threads, each with its own isolate + AddonState, and verifies
// each emits GC metrics. Reads the worker body (plus the shared prelude) from disk and
// evaluates it via { eval: true }, avoiding a script-embedded-in-a-string.
const fs = require('fs');
const { Worker } = require('worker_threads');

const prelude = fs.readFileSync('test/fixtures/_prelude.cjs', 'utf8');
const workerBody = fs.readFileSync('test/fixtures/worker-isolates-worker.cjs', 'utf8');
const workerScript = prelude + '\n' + workerBody;

Promise.all(Array.from({length: 4}, () => new Promise((resolve, reject) => {
  const worker = new Worker(workerScript, {eval: true});
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', (code) => {
    if (code !== 0) {
      reject(new Error('worker exited with code ' + code));
    }
  });
}))).then((messages) => {
  console.log(messages.join(','));
}, (err) => {
  console.error(err && err.stack || err);
  process.exit(2);
});
