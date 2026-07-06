// Shared helpers prepended to each child-process fixture (run via `node --expose-gc -e`).
// These fixtures are read as text and executed as CJS, so `require('.')` resolves
// relative to the child's cwd (the package root) exactly as an inline `-e` script would.

function forceGc(rounds) {
  const total = rounds || 20;
  for (let round = 0; round < total; ++round) {
    const allocations = [];
    for (let i = 0; i < 5000; ++i) {
      allocations.push({i, data: 'x'.repeat(1024)});
    }
    global.gc();
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
