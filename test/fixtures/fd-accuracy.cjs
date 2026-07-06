// fd-accuracy: validate native file-descriptor capture via internals.GetCurMaxFd().
// Cross-platform. On linux, `used` reflects real /proc/self/fd count and must rise by
// >= N after opening N files (it also counts the opendir fd, hence >=). On darwin/bsd
// there is no /proc, so `used` is documented to be 0. `max` is getrlimit(RLIMIT_NOFILE):
// either null (unlimited) or a positive integer, on both platforms.
const fs = require('fs');
const internals = require('./build/Release/spectator_internals.node');

// Under `node -e`, __filename is the non-existent "[eval]", so open a file that is
// guaranteed to exist and be openable for reading: the node executable itself.
const OPENABLE = process.execPath;

function fail(msg, extra) {
  console.error('fd-accuracy FAIL:', msg, extra === undefined ? '' : JSON.stringify(extra));
  process.exit(2);
}

function checkShape(label, s) {
  if (s === null || typeof s !== 'object') {
    fail(label + ': result not an object', s);
  }
  if (typeof s.used !== 'number' || !Number.isFinite(s.used) || s.used < 0) {
    fail(label + ': used must be a finite non-negative number', s);
  }
  if (!(s.max === null || (typeof s.max === 'number' && Number.isInteger(s.max) && s.max > 0))) {
    fail(label + ': max must be null (unlimited) or a positive integer', s);
  }
}

// (A) baseline
const baseline = internals.GetCurMaxFd();
checkShape('baseline', baseline);

if (process.platform === 'linux') {
  // (B-linux) open N real files and assert `used` climbs by at least N.
  const N = 16;
  const fds = [];
  try {
    for (let i = 0; i < N; ++i) {
      fds.push(fs.openSync(OPENABLE, 'r'));
    }
    const after = internals.GetCurMaxFd();
    checkShape('after-open', after);
    const delta = after.used - baseline.used;
    if (delta < N) {
      fail('used did not increase by at least N after opening N files', {
        baselineUsed: baseline.used,
        afterUsed: after.used,
        N,
        delta,
      });
    }
    // max is a stable property of the process; it must not change.
    if (after.max !== baseline.max) {
      fail('max changed unexpectedly between samples', {baselineMax: baseline.max, afterMax: after.max});
    }
  } finally {
    for (const fd of fds) {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  }
} else {
  // (B-nonlinux) documented no-/proc behavior: used is always 0.
  if (baseline.used !== 0) {
    fail('on ' + process.platform + ' used must be 0 (no /proc/self/fd)', baseline);
  }
  // Opening files must NOT change `used` on platforms without /proc.
  const fds = [];
  try {
    for (let i = 0; i < 8; ++i) {
      fds.push(fs.openSync(OPENABLE, 'r'));
    }
    const after = internals.GetCurMaxFd();
    checkShape('after-open', after);
    if (after.used !== 0) {
      fail('on ' + process.platform + ' used must stay 0 even after opening files', after);
    }
    if (after.max !== baseline.max) {
      fail('max changed unexpectedly between samples', {baselineMax: baseline.max, afterMax: after.max});
    }
  } finally {
    for (const fd of fds) {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  }
}

// (C) both platforms: final shape re-check (max null-or-positive-int, used number).
checkShape('final', internals.GetCurMaxFd());

console.log('FD_ACCURACY_OK platform=' + process.platform);
