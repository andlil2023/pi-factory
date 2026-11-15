import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitCheckpoint } from '../src/git-checkpoint.ts';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-checkpoint-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'README.md'), 'initial\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial');
  const main = git(root, 'rev-parse', 'HEAD');
  const worktree = join(root, 'worktree');
  git(root, 'worktree', 'add', '-qb', 'factory/run-test', worktree);
  return { root, worktree, main };
}

test('commits new and modified files on factory branch without modifying main', async t => {
  const { root, worktree, main } = await fixture(t);
  await writeFile(join(worktree, 'calculator.js'), 'console.log(15);\n');
  await writeFile(join(worktree, 'README.md'), 'updated\n');
  const result = await createGitCheckpoint({ worktree, branch: 'factory/run-test', taskId: 'T001', title: 'Calculator' });
  assert.notEqual(result.commit, main);
  assert.deepEqual(result.changedFiles.sort(), ['README.md', 'calculator.js']);
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.equal(git(root, 'rev-parse', 'HEAD'), main);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'initial\n');
});

test('rejects wrong branch and stale baseline', async t => {
  const { worktree } = await fixture(t);
  await writeFile(join(worktree, 'new.txt'), 'new');
  await assert.rejects(createGitCheckpoint({ worktree, branch: 'factory/other', taskId: 'T001', title: 'Test' }), /Wrong branch/);
  await assert.rejects(createGitCheckpoint({ worktree, branch: 'factory/run-test', taskId: 'T001', title: 'Test', expectedHead: 'bad' }), /HEAD changed/);
});

test('refuses to commit factory state', async t => {
  const { worktree } = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(worktree, '.factory'));
  await writeFile(join(worktree, '.factory', 'state.json'), '{}');
  await assert.rejects(createGitCheckpoint({ worktree, branch: 'factory/run-test', taskId: 'T001', title: 'Test' }), /Refusing/);
  assert.equal(git(worktree, 'rev-list', '--count', 'HEAD'), '1');
});

test('rejects empty checkpoints', async t => {
  const { worktree } = await fixture(t);
  await assert.rejects(createGitCheckpoint({ worktree, branch: 'factory/run-test', taskId: 'T001', title: 'Test' }), /No changes/);
});
