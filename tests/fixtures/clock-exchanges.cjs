// Diagnostic only: see docs/windows-clock-measurements.md for safe JSON capture.
const { fork } = require('node:child_process');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const os = require('node:os');
function sample() {
  const a = process.hrtime.bigint(), w = Date.now(), b = process.hrtime.bigint();
  return { a: String(a), w, b: String(b) };
}
if (!isMainThread) {
  parentPort.on('message', () => parentPort.postMessage(sample()));
} else if (process.argv[2] === 'child') {
  process.on('message', () => process.send(sample()));
} else {
  const mode = process.argv[2];
  if (!['ipc', 'worker'].includes(mode)) throw Error('Expected ipc or worker');
  const peer = mode === 'ipc' ? fork(__filename, ['child'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }) : new Worker(__filename);
  const send = mode === 'ipc' ? () => peer.send(0) : () => peer.postMessage(0);
  const rows = [];
  let before = sample();
  peer.on('error', error => { throw error; });
  peer.on('message', child => {
    const after = sample();
    rows.push({ before, child, after });
    if (rows.length === 1000) {
      console.log(JSON.stringify({ mode, version: process.version, platform: process.platform, arch: process.arch, release: os.release(), uv: process.versions.uv, rows }));
      if (mode === 'ipc') peer.disconnect(); else peer.terminate();
    } else { before = sample(); send(); }
  });
  send();
}
