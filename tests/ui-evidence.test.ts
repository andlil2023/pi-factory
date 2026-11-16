import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContractValidator } from '../src/contract-validator.ts';
import { collectUiEvidence, sourceFingerprint, assertUiEvidenceCurrent, validateUiEvidenceCommand, isUiEvidenceTimestampWithinCollection } from '../src/ui-evidence.ts';

const validator = new ContractValidator(resolve('contracts'));
async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-ui-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = join(dir, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init'], { cwd: repository });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'], { cwd: repository });
  await writeFile(join(repository, 'source.txt'), 'original');
  return { repository, directory: join(dir, 'evidence') };
}
function config(directory: string, mode = 'passed') {
  return { directory, command: { executable: process.execPath, args: [resolve('tests/fixtures/fake-ui-collector.mjs'), mode] } };
}

test('validates trusted command settings', () => {
  for (const command of [{ executable: '' }, { executable: 'test', args: [1] }, { executable: 'test', timeoutMs: 0 }]) {
    assert.throws(() => validateUiEvidenceCommand(command as Parameters<typeof validateUiEvidenceCommand>[0]));
  }
});

test('timestamp validation permits only the inclusive 50 ms cross-process margin', () => {
  const started = Date.parse('2026-01-01T00:00:01.000Z');
  const ended = started + 1000;
  for (const [time, expected] of [
    [started - 51, false], [started - 50, true], [started - 1, true],
    [started, true], [ended, true], [ended + 1, true],
    [ended + 50, true], [ended + 51, false]
  ] as const) {
    assert.equal(isUiEvidenceTimestampWithinCollection(new Date(time).toISOString(), started, ended), expected, String(time));
  }
  assert.equal(isUiEvidenceTimestampWithinCollection('invalid', started, ended), false);
});

test('collects task-bound desktop evidence and hashes real artifacts outside the worktree', async t => {
  const { repository, directory } = await fixture(t);
  const record = await collectUiEvidence(config(directory), { repository, taskId: 'T001', attempt: 2 }, validator);
  assert.equal(record.passed, true, record.issues.join('\n'));
  assert.equal(record.manifest?.application.framework, 'wpf');
  assert.equal(record.manifest?.attempt, 2);
  assert.equal(record.manifest?.sourceFingerprint, await sourceFingerprint(repository));
  assert.equal(record.artifacts.length, 2);
  assert.match(record.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  await assertUiEvidenceCurrent(record, repository);
  const again = await collectUiEvidence(config(directory), { repository, taskId: 'T001', attempt: 2 }, validator);
  assert.equal(again.passed, true, again.issues.join('\n'));
  assert.notEqual(again.directory, record.directory);
});

for (const [mode, issue] of [
  ['nonzero', /collector command failed/], ['missing-manifest', /ENOENT/], ['malformed', /Invalid UI evidence manifest/],
  ['wrong-task', /task\/attempt mismatch/], ['wrong-attempt', /task\/attempt mismatch/],
  ['stale', /timestamp/], ['future', /timestamp/], ['invalid-timestamp', /timestamp/],
  ['fingerprint', /fingerprint mismatch/], ['failed-check', /failed checks/],
  ['missing-check', /Missing accessibility check/], ['missing-artifact', /Missing accessibility-tree artifact/],
  ['missing-file', /ENOENT/], ['invalid-image', /PNG or JPEG/], ['traversal', /escapes/], ['absolute', /escapes/],
  ['symlink', /symlink escapes/], ['duplicate', /Duplicate/], ['source-mutation', /Source changed/]
] as const) {
  test(`rejects ${mode} UI evidence`, async t => {
    const { repository, directory } = await fixture(t);
    const record = await collectUiEvidence(config(directory, mode), { repository, taskId: 'T001', attempt: 1 }, validator);
    assert.equal(record.passed, false);
    assert.match(record.issues.join('\n'), issue);
  });
}

test('rejects evidence output directories inside the worktree', async t => {
  const { repository } = await fixture(t);
  const record = await collectUiEvidence(config(join(repository, 'evidence')), { repository, taskId: 'T001', attempt: 1 }, validator);
  assert.equal(record.passed, false);
  assert.match(record.issues.join('\n'), /outside the target worktree/);
});

test('rejects artifacts and source modified after collection', async t => {
  const { repository, directory } = await fixture(t);
  const record = await collectUiEvidence(config(directory), { repository, taskId: 'T001', attempt: 1 }, validator);
  assert.equal(record.passed, true, record.issues.join('\n'));
  const original = await readFile(record.artifacts[0].path);
  await writeFile(record.artifacts[0].path, 'tampered');
  await assert.rejects(assertUiEvidenceCurrent(record, repository), /artifact changed/);
  await writeFile(record.artifacts[0].path, original);
  await writeFile(join(repository, 'source.txt'), 'new source');
  await assert.rejects(assertUiEvidenceCurrent(record, repository), /stale/);
});
