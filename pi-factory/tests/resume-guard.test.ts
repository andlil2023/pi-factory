import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree } from '../src/git-worktree.ts';
import { inspectResume } from '../src/resume-guard.ts';
import type { FactoryRunState } from '../src/state-store.ts';

async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-factory-resume-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'calculator');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), 'initial\n');
  git('add', '.'); git('commit', '-m', 'Initial');
  const runId = 'run-resume-test';
  const worktree = await createWorktree({ repository: repo, runId });
  const state: FactoryRunState = {
    version: 1, runId, repository: repo, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'paused', plan: {}, tasks: { T001: { id: 'T001', status: 'pending', attempts: [] } }
  };
  return { repo, worktree, state, git };
}

test('allows a clean, pending run to resume', async t => {
  const f = await fixture(t);
  const result = await inspectResume(f.state, f.repo);
  assert.equal(result.worktree, f.worktree.path);
  assert.equal(result.head, f.worktree.baseCommit);
});

test('refuses uncommitted changes without modifying them', async t => {
  const f = await fixture(t);
  await writeFile(join(f.worktree.path, 'new.txt'), 'valuable work');
  await assert.rejects(inspectResume(f.state, f.repo), /uncommitted changes/);
});

test('refuses in-flight attempts even when worktree is clean', async t => {
  const f = await fixture(t);
  f.state.tasks.T001.status = 'running';
  await assert.rejects(inspectResume(f.state, f.repo), /manual recovery required/);
});

test('refuses a completed run', async t => {
  const f = await fixture(t);
  f.state.status = 'completed';
  await assert.rejects(inspectResume(f.state, f.repo), /already completed/);
});

test('refuses changed HEAD without a recorded checkpoint', async t => {
  const f = await fixture(t);
  execFileSync('git', ['-C', f.worktree.path, 'commit', '--allow-empty', '-m', 'unexpected']);
  // A run without completed tasks must still be at its original baseline.
  await assert.rejects(inspectResume(f.state, f.repo), /HEAD differs|baseline/);
});
