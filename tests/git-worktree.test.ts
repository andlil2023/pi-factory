import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorktree, removeWorktree, getWorktreeDiff } from '../src/git-worktree.ts';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-factory-git-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const repository = join(dir, 'project');
  await mkdir(repository);
  git(repository, 'init');
  git(repository, 'config', 'user.email', 'test@example.invalid');
  git(repository, 'config', 'user.name', 'Test');
  git(repository, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repository, 'README.md'), 'initial\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'initial');
  return { dir, repository };
}

test('creates isolated worktree without changing main repository', async t => {
  const { dir, repository } = await fixture(t);
  const info = await createWorktree({ repository, runId: 'run-001', worktreesDirectory: join(dir, 'worktrees') });
  assert.equal(await readFile(join(info.path, 'README.md'), 'utf8'), 'initial\n');
  await writeFile(join(info.path, 'README.md'), 'changed\n');
  assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), 'initial\n');
  assert.match(await getWorktreeDiff(info), /changed/);
  await assert.rejects(removeWorktree(info), /failed/); // refuse dirty deletion
  git(info.path, 'add', '.');
  git(info.path, 'commit', '-m', 'change');
  await removeWorktree(info);
});

test('rejects unsafe IDs and duplicate run IDs', async t => {
  const { dir, repository } = await fixture(t);
  await assert.rejects(createWorktree({ repository, runId: '../escape' }), /Invalid runId/);
  const options = { repository, runId: 'run-002', worktreesDirectory: join(dir, 'worktrees') };
  const info = await createWorktree(options);
  await assert.rejects(createWorktree(options));
  await removeWorktree(info);
});

test('refuses dirty source repositories', async t => {
  const { repository } = await fixture(t);
  await writeFile(join(repository, 'README.md'), 'dirty\n');
  await assert.rejects(createWorktree({ repository, runId: 'run-003' }), /clean working tree/);
});
