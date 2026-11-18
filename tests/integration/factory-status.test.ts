import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('status reports persisted infrastructure retries per task only when used', async t => {
  const repository = await mkdtemp(join(tmpdir(), 'factory-status-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const directory = join(repository, '.factory', 'runs');
  await mkdir(directory, { recursive: true });
  const retry = { role: 'implementer', error: 'timeout' };
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({
    version: 1, runId: 'fixture', repository, status: 'paused',
    execution: { maxAttempts: 3, maxInfraRetries: 2 },
    tasks: {
      T001: { id: 'T001', status: 'completed', attempts: [
        { number: 1, outcome: 'error', infraRetry: retry },
        { number: 2, outcome: 'error', infraRetry: { role: 'reviewer', error: 'exit' } },
        { number: 3, outcome: 'implemented', finishedAt: 'now' }
      ] },
      T002: { id: 'T002', status: 'pending', attempts: [] },
      T003: { id: 'T003', status: 'blocked', attempts: [{ number: 1, outcome: 'error' }] }
    },
    supersededTasks: [
      { task: { id: 'T004', attempts: [{ number: 1, outcome: 'error', infraRetry: retry }] } },
      { task: { id: 'T005', attempts: [] } }
    ]
  }));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), 'status', '--repo', repository, '--run', 'fixture'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /T001: completed, attempts=3 \(budget used 1\/3\), infrastructure retries used=2/);
  assert.match(result.stdout, /T002: pending, attempts=0 \(budget used 0\/3\)\r?\n/);
  assert.match(result.stdout, /T003: blocked, attempts=1 \(budget used 0\/3\)\r?\n/);
  assert.match(result.stdout, /T004: superseded by plan amendment, attempts=1, infrastructure retries used=1\r?\n/);
  assert.match(result.stdout, /T005: superseded by plan amendment, attempts=0\r?\n/);
});
