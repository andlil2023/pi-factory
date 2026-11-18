import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoReplanCandidate, stashLeftover } from '../src/auto-replan.ts';
import type { AttemptRecord, FactoryRunState, TaskState } from '../src/state-store.ts';

const attempt = (number: number, extra: Partial<AttemptRecord> = {}): AttemptRecord => ({ number, startedAt: 'a', finishedAt: 'b', outcome: 'implemented', ...extra });
const state = (task: Partial<TaskState>, extra: Partial<FactoryRunState> = {}): FactoryRunState => ({
  version: 1, runId: 'run-x', repository: 'r', createdAt: 'a', updatedAt: 'b', status: 'blocked', plan: {},
  tasks: { T001: { id: 'T001', status: 'completed', attempts: [attempt(1)] }, T002: { id: 'T002', status: 'blocked', attempts: [], ...task } }, ...extra });
const tooLarge = { outcome: 'blocked' as const, implementationReport: { blockers: [{ kind: 'task_too_large', description: 'big', proposedSplit: ['a', 'b'] }] } };

test('task_too_large and an exhausted repair budget are replanned automatically', () => {
  assert.deepEqual(autoReplanCandidate(state({ attempts: [attempt(1, tooLarge)], lastError: 'task_too_large: big' }), 3, 2), { taskId: 'T002', reason: 'task_too_large' });
  const exhausted = state({ attempts: [attempt(1), attempt(2), attempt(3)], lastError: 'Maximum attempts (3) exhausted: Deterministic verification failed' });
  assert.deepEqual(autoReplanCandidate(exhausted, 3, 2), { taskId: 'T002', reason: 'budget_exhausted' });
});

test('decisions, missing environment, reviewer blocks and errors always stop for the operator', () => {
  const blocked = (kind: string) => state({ attempts: [attempt(1, { outcome: 'blocked', implementationReport: { blockers: [{ kind, description: 'x' }] } })], lastError: `${kind}: x` });
  assert.equal(autoReplanCandidate(blocked('decision_needed'), 3, 2), undefined);
  assert.equal(autoReplanCandidate(blocked('environment_missing'), 3, 2), undefined);
  const mixed = state({ attempts: [attempt(1, { outcome: 'blocked', implementationReport: { blockers: [{ kind: 'task_too_large', description: 'x' }, { kind: 'decision_needed', description: 'y' }] } })] });
  assert.equal(autoReplanCandidate(mixed, 3, 2), undefined);
  const reviewerBlocked = state({ attempts: [attempt(1, { reviews: [{ reviewer: 'code', verdict: 'blocked', report: {} }] })], lastError: 'Missing, duplicate, or blocked required review' });
  assert.equal(autoReplanCandidate(reviewerBlocked, 3, 2), undefined);
  const error = state({ attempts: [attempt(1, { outcome: 'error' })], lastError: 'Agent/verification error: boom' });
  assert.equal(autoReplanCandidate(error, 3, 2), undefined);
  const interrupted = state({ attempts: [attempt(1), attempt(2), attempt(3, { outcome: 'interrupted' })], lastError: 'Execution interrupted; inspect working tree before resuming' });
  assert.equal(autoReplanCandidate(interrupted, 3, 2), undefined);
});

test('the replan budget, run status and task count bound automatic replanning', () => {
  const candidate = { attempts: [attempt(1, tooLarge)] };
  const record = { at: 'x', taskId: 'T009', reason: 'task_too_large' as const, superseded: [], added: [] };
  assert.equal(autoReplanCandidate(state(candidate), 3, 0), undefined, 'disabled');
  assert.equal(autoReplanCandidate(state(candidate, { autoReplans: [record, record] }), 3, 2), undefined, 'budget spent');
  assert.ok(autoReplanCandidate(state(candidate, { autoReplans: [record] }), 3, 2));
  assert.equal(autoReplanCandidate(state(candidate, { status: 'completed' }), 3, 2), undefined);
  const two = state(candidate);
  two.tasks.T003 = { id: 'T003', status: 'blocked', attempts: [attempt(1, tooLarge)] };
  assert.equal(autoReplanCandidate(two, 3, 2), undefined, 'ambiguous state');
});

test('leftover edits are saved as a patch before the run worktree is reset to its checkpoint', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'factory-leftover-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'kept.txt'), 'base\n'); await writeFile(join(repo, '.gitignore'), 'ignored/\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const worktree = join(dir, 'worktree');
  git(repo, 'worktree', 'add', '-b', 'factory/run-x', worktree);
  const head = git(worktree, 'rev-parse', 'HEAD');
  const gitState = { worktree, runBranch: 'factory/run-x', targetBranch: 'main', baseCommit: head, expectedHead: head };
  const leftovers = join(dir, 'leftover');

  assert.equal(await stashLeftover(repo, gitState, leftovers, 'T002-1'), undefined, 'clean worktree: nothing to save');

  await writeFile(join(worktree, 'kept.txt'), 'base\nPARTIAL_EDIT\n');
  await mkdir(join(worktree, 'new')); await writeFile(join(worktree, 'new', 'file.txt'), 'UNTRACKED_WORK\n');
  await mkdir(join(worktree, 'ignored')); await writeFile(join(worktree, 'ignored', 'dep.txt'), 'dependency');
  await writeFile(join(repo, 'operator-edit.txt'), 'must survive');
  const patch = await stashLeftover(repo, gitState, leftovers, 'T002-1');
  assert.equal(patch, join(leftovers, 'T002-1.patch'));
  const text = await readFile(patch!, 'utf8');
  assert.match(text, /PARTIAL_EDIT/); assert.match(text, /UNTRACKED_WORK/);
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.equal(await readFile(join(worktree, 'kept.txt'), 'utf8').then(value => value.replace(/\r/g, '')), 'base\n');
  assert.equal(await readFile(join(worktree, 'ignored', 'dep.txt'), 'utf8'), 'dependency', 'ignored files such as installed dependencies stay');
  assert.equal(await readFile(join(repo, 'operator-edit.txt'), 'utf8'), 'must survive', 'the source checkout is never touched');
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), head);
  // The saved patch restores the work.
  git(worktree, 'apply', patch!);
  assert.match(await readFile(join(worktree, 'new', 'file.txt'), 'utf8'), /UNTRACKED_WORK/);
  git(worktree, 'reset', '--hard'); git(worktree, 'clean', '-fd');

  await assert.rejects(stashLeftover(repo, { ...gitState, worktree: repo }, leftovers, 'x'), /source repository/);
  await writeFile(join(worktree, 'kept.txt'), 'dirty');
  await assert.rejects(stashLeftover(repo, { ...gitState, expectedHead: '0'.repeat(40) }, leftovers, 'y'), /HEAD differs/);
  assert.equal(await readFile(join(worktree, 'kept.txt'), 'utf8'), 'dirty', 'a failed precondition changes nothing');
  await assert.rejects(stashLeftover(repo, gitState, leftovers, '../escape'), /Invalid leftover name/);
});
