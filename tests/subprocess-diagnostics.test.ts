import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertSubprocessStarted, subprocessDiagnostics } from './subprocess-diagnostics.ts';

test('subprocess diagnostics report controlled failures and bound output', () => {
  const failed = spawnSync(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000)); process.stderr.write('failure'); process.exit(7)"], { encoding: 'utf8', timeout: 5000 });
  assertSubprocessStarted(failed);
  const message = subprocessDiagnostics(failed);
  assert.match(message, /status: 7; error code: unavailable; signal: none/);
  assert.match(message, /\[truncated\]/);
  assert.match(message, /stderr: failure/);
  assert.ok(message.length < 4300);

  const missing = spawnSync('factory-nonexistent-executable-for-test', [], { encoding: 'utf8', timeout: 5000 });
  assert.throws(() => assertSubprocessStarted(missing), /error code: ENOENT; signal: none/);
  const signalled = { ...failed, signal: 'SIGTERM' as const };
  assert.throws(() => assertSubprocessStarted(signalled), /signal: SIGTERM/);
});
