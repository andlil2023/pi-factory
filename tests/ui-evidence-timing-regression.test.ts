import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContractValidator } from '../src/contract-validator.ts';
import { assertUiEvidenceCurrent, collectUiEvidence } from '../src/ui-evidence.ts';

test('collection accepts the observed 4 ms post-end clock offset', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-ui-clock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = join(dir, 'repository');
  const directory = join(dir, 'evidence');
  await mkdir(repository);
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: repository });

  // Model the first recorded T001 observation, not a claim about the host clock:
  // the unmodified collector's real capture reads 4 ms after the parent's end.
  // Only the parent's two boundary samples are controlled; all validation remains real.
  const realNow = Date.now;
  let samples = 0;
  let started = 0;
  let ended = 0;
  Date.now = () => {
    if (++samples === 1) return started = realNow();
    if (samples !== 2) throw new Error('Unexpected clock sample');
    const entries = readdirSync(directory);
    assert.equal(entries.length, 1);
    const manifest = JSON.parse(readFileSync(join(directory, entries[0], 'manifest.json'), 'utf8')) as { capturedAt: string };
    return ended = Date.parse(manifest.capturedAt) - 4;
  };
  let record: Awaited<ReturnType<typeof collectUiEvidence>>;
  try {
    record = await collectUiEvidence({ directory, command: { executable: process.execPath, args: [resolve('tests/fixtures/fake-ui-collector.mjs')] } },
      { repository, taskId: 'T002', attempt: 1 }, new ContractValidator(resolve('contracts')));
  } finally {
    Date.now = realNow;
  }
  assert.equal(samples, 2);
  assert.ok(ended >= started, 'modeled end must not precede the start');
  assert.equal(Date.parse(record.manifest!.capturedAt) - ended, 4);
  assert.equal(record.passed, true, record.issues.join('\n'));
  assert.equal(record.artifacts.length, 2);
  await assertUiEvidenceCurrent(record, repository);
});
