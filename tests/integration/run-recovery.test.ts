import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorktree } from '../../src/git-worktree.ts';
import { createGitCheckpoint } from '../../src/git-checkpoint.ts';
import { StateStore, consumedInfraRetries } from '../../src/state-store.ts';
import { AgentExecutionError } from '../../src/agent-error.ts';
import { Orchestrator } from '../../src/orchestrator.ts';
import { captureRunGitState, configurationFingerprint, prepareRunResume, validateRunGitState } from '../../src/run-recovery.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
const fingerprint = configurationFingerprint({ execution: { maxAttempts: 3 }, verification: ['trusted-test'] });
async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = join(dir, 'project');
  await mkdir(repository);
  git(repository, 'init');
  git(repository, 'config', 'user.name', 'Test');
  git(repository, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repository, '.gitignore'), '.factory/\n');
  await writeFile(join(repository, 'source.txt'), 'original');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'initial');
  const info = await createWorktree({ repository, runId: 'run-recovery', worktreesDirectory: join(dir, 'worktrees') });
  const metadata = await captureRunGitState(info);
  const store = new StateStore(repository);
  const state = await store.create(repository, {}, ['T001', 'T002'], 'run-recovery', { git: metadata, execution: { maxAttempts: 3, configurationFingerprint: fingerprint } });
  return { dir, repository, info, store, state };
}

test('configuration identity ignores object-key order, not changes to trusted settings', () => {
  assert.equal(configurationFingerprint({ a: { x: 1, y: 2 }, b: [1, 2] }), configurationFingerprint({ b: [1, 2], a: { y: 2, x: 1 } }));
  assert.notEqual(configurationFingerprint({ budget: 3 }), configurationFingerprint({ budget: 4 }));
});

test('legacy configuration resumes unchanged with zero infrastructure retries', async t => {
  const { repository, store, state } = await fixture(t);
  const loaded = await store.load(state.runId);
  const resumed = await prepareRunResume(store, loaded, repository, fingerprint, 3);
  assert.equal(resumed.execution?.configurationFingerprint, fingerprint);
  assert.equal(resumed.execution?.maxInfraRetries, undefined);
  const tasks = ['T001', 'T002'].map(id => ({ id, title: id, objective: 'A', scope: 'A', acceptanceCriteria: ['A'], dependencies: [], verification: ['test'] }));
  const result = await new Orchestrator(store, {
    implement: async () => { throw new AgentExecutionError('implementer', true, 'timeout'); },
    verify: async () => ({ passed: true, details: {} }),
    review: async () => []
  }).execute(resumed, tasks);
  assert.equal(result.status, 'blocked');
  assert.equal(result.tasks.T001.attempts.length, 1);
  assert.equal(consumedInfraRetries(result.tasks.T001), 0);
});

test('operator resume preserves exhausted infrastructure retry usage', async t => {
  const { repository, store, state } = await fixture(t);
  state.execution!.maxInfraRetries = 1;
  const tasks = ['T001', 'T002'].map(id => ({ id, title: id, objective: 'A', scope: 'A', acceptanceCriteria: ['A'], dependencies: [], verification: ['test'] }));
  const adapters = {
    implement: async () => { throw new AgentExecutionError('implementer', true, 'timeout'); },
    verify: async () => ({ passed: true, details: {} }),
    review: async () => []
  };
  await new Orchestrator(store, adapters).execute(state, tasks);
  const loaded = await store.load(state.runId);
  assert.equal(loaded.tasks.T001.attempts.length, 2);
  assert.equal(consumedInfraRetries(loaded.tasks.T001), 1);
  await assert.rejects(prepareRunResume(store, loaded, repository, fingerprint, 3, 'T001', undefined, 0), /original execution configuration/);
  const resumed = await prepareRunResume(store, loaded, repository, fingerprint, 3, 'T001', undefined, 1);
  const result = await new Orchestrator(store, adapters).execute(resumed, tasks);
  assert.equal(result.status, 'blocked');
  assert.equal(result.tasks.T001.attempts.length, 3);
  assert.equal(consumedInfraRetries((await store.load(state.runId)).tasks.T001), 1);
});

test('persists Git metadata and resumes pending work without replaying attempts', async t => {
  const { repository, info, store, state } = await fixture(t);
  const loaded = await store.load(state.runId);
  assert.equal(loaded.git?.runBranch, info.branch);
  assert.equal(loaded.git?.baseCommit, info.baseCommit);
  assert.equal(loaded.git?.expectedHead, info.baseCommit);
  assert.equal((await validateRunGitState(loaded, repository)).dirty, false);
  const resumed = await prepareRunResume(store, loaded, repository, fingerprint, 3);
  assert.equal(resumed.status, 'paused');
  assert.equal(resumed.tasks.T001.status, 'pending');
  assert.equal(resumed.resumptions?.length, 1);
});

test('validates completed checkpoint chain and preserves it when resuming remaining work', async t => {
  const { repository, info, store, state } = await fixture(t);
  await writeFile(join(info.path, 'source.txt'), 'accepted');
  const checkpoint = await createGitCheckpoint({ worktree: info.path, branch: info.branch, taskId: 'T001', title: 'Accepted task', expectedHead: info.baseCommit });
  state.tasks.T001.status = 'completed';
  state.tasks.T001.checkpointCommit = checkpoint.commit;
  state.tasks.T001.attempts = [{ number: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), checkpointCommit: checkpoint.commit }];
  state.git!.expectedHead = checkpoint.commit;
  await store.save(state);
  await validateRunGitState(state, repository);
  const resumed = await prepareRunResume(store, await store.load(state.runId), repository, fingerprint, 3);
  assert.equal(resumed.tasks.T001.status, 'completed');
  assert.equal(resumed.git?.expectedHead, checkpoint.commit);
  state.tasks.T001.checkpointCommit = undefined;
  await assert.rejects(validateRunGitState(state, repository), /checkpoint metadata/);
});

for (const interruptedStatus of ['running', 'needs_review'] as const) {
  test(`explicitly retries ${interruptedStatus} work without discarding edits or resetting history`, async t => {
    const { repository, info, store, state } = await fixture(t);
    state.status = 'running';
    state.tasks.T001.status = interruptedStatus;
    state.tasks.T001.reviewSelection = { requiredReviewers: ['code', 'security'], changedFiles: ['source.txt'], reasons: ['Prior requirement'] };
    state.tasks.T001.attempts = [{ number: 1, startedAt: new Date().toISOString(), verification: { passed: false } }];
    await writeFile(join(info.path, 'source.txt'), 'preserve interrupted work');
    await store.save(state);
    await assert.rejects(prepareRunResume(store, state, repository, fingerprint, 3), /--retry-task T001/);
    assert.equal((await store.load(state.runId)).tasks.T001.attempts[0].outcome, undefined);
    const resumed = await prepareRunResume(store, state, repository, fingerprint, 3, 'T001');
    assert.equal(resumed.tasks.T001.status, 'repair_pending');
    assert.equal(resumed.tasks.T001.attempts.length, 1);
    assert.equal(resumed.tasks.T001.attempts[0].outcome, 'interrupted');
    assert.deepEqual(resumed.tasks.T001.reviewSelection?.requiredReviewers, ['code', 'security']);
    assert.equal(await readFile(join(info.path, 'source.txt'), 'utf8'), 'preserve interrupted work');
    assert.equal(git(info.path, 'rev-parse', 'HEAD'), info.baseCommit);
  });
}

test('cannot reset exhausted budgets or change configuration during resume', async t => {
  const { repository, store, state } = await fixture(t);
  state.tasks.T001.status = 'blocked';
  state.tasks.T001.attempts = [1, 2, 3].map(number => ({ number, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  await store.save(state);
  await assert.rejects(prepareRunResume(store, state, repository, fingerprint, 3, 'T001'), /budget exhausted/);
  await assert.rejects(prepareRunResume(store, state, repository, fingerprint, 4, 'T001'), /original execution configuration/);
  await assert.rejects(prepareRunResume(store, state, repository, 'changed', 3, 'T001'), /original execution configuration/);
});

test('rejects dirty pending work, wrong retry IDs and multiple active tasks', async t => {
  const { repository, info, store, state } = await fixture(t);
  await writeFile(join(info.path, 'unknown.txt'), 'preserve');
  await assert.rejects(prepareRunResume(store, state, repository, fingerprint, 3), /worktree is dirty/);
  await assert.rejects(prepareRunResume(store, state, repository, fingerprint, 3, 'T001'), /existing failed/);
  state.tasks.T001.status = 'blocked';
  state.tasks.T002.status = 'running';
  await assert.rejects(prepareRunResume(store, state, repository, fingerprint, 3, 'T001'), /Multiple unfinished/);
});

test('refuses unauthorized commits without changing or deleting them', async t => {
  const { repository, info, state } = await fixture(t);
  git(info.path, 'commit', '--allow-empty', '-m', 'unauthorized');
  const head = git(info.path, 'rev-parse', 'HEAD');
  await assert.rejects(validateRunGitState(state, repository, true), /HEAD differs/);
  assert.equal(git(info.path, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repository, 'rev-parse', 'HEAD'), info.baseCommit);
});

test('rejects wrong branches, missing worktrees, and unrelated repositories', async t => {
  const { repository, info, state } = await fixture(t);
  const foreign = await fixture(t);
  state.git!.worktree = foreign.info.path;
  await assert.rejects(validateRunGitState(state, repository), /another repository/);
  state.git!.worktree = join(repository, 'missing');
  await assert.rejects(validateRunGitState(state, repository), /ENOENT/);
  state.git!.worktree = info.path;
  git(info.path, 'checkout', '-b', 'unrelated-branch');
  await assert.rejects(validateRunGitState(state, repository), /worktree\/branch/);
});

test('refuses unfinished Git operations without attempting an abort', async t => {
  const { repository, info, state } = await fixture(t);
  const mergeHead = resolve(info.path, git(info.path, 'rev-parse', '--git-path', 'MERGE_HEAD'));
  await writeFile(mergeHead, `${info.baseCommit}\n`);
  await assert.rejects(validateRunGitState(state, repository, true), /Unfinished Git operation/);
  assert.equal((await readFile(mergeHead, 'utf8')).trim(), info.baseCommit);
});

test('target may advance without being merged into the isolated run', async t => {
  const { repository, info, state } = await fixture(t);
  await writeFile(join(repository, 'target-only.txt'), 'new target work');
  git(repository, 'add', 'target-only.txt');
  git(repository, 'commit', '-m', 'target advance');
  const observed = await validateRunGitState(state, repository);
  assert.notEqual(observed.targetHead, info.baseCommit);
  assert.equal(git(info.path, 'rev-parse', 'HEAD'), info.baseCommit);
});

test('checkpoint-created/state-not-saved crash fails closed without adopting the commit', async t => {
  const { repository, info, store, state } = await fixture(t);
  await writeFile(join(info.path, 'source.txt'), 'checkpoint before crash');
  const checkpoint = await createGitCheckpoint({ worktree: info.path, branch: info.branch, taskId: 'T001', title: 'Unsaved checkpoint', expectedHead: info.baseCommit });
  const persisted = await store.load(state.runId);
  await assert.rejects(validateRunGitState(persisted, repository, true), /HEAD differs/);
  assert.equal(git(info.path, 'rev-parse', 'HEAD'), checkpoint.commit);
  assert.equal((await store.load(state.runId)).git?.expectedHead, info.baseCommit);
});

test('final-verification-only resume does not replay accepted tasks', async t => {
  const { repository, info, store, state } = await fixture(t);
  for (const id of ['T001', 'T002']) {
    await writeFile(join(info.path, 'source.txt'), id);
    const checkpoint = await createGitCheckpoint({ worktree: info.path, branch: info.branch, taskId: id, title: 'Accepted task', expectedHead: state.git!.expectedHead });
    state.git!.expectedHead = checkpoint.commit;
    state.tasks[id].status = 'completed';
    state.tasks[id].checkpointCommit = checkpoint.commit;
    state.tasks[id].attempts = [{ number: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), checkpointCommit: checkpoint.commit }];
  }
  state.status = 'blocked';
  state.finalVerification = { passed: false, details: 'Transient external failure', checkedAt: new Date().toISOString() };
  await store.save(state);
  const resumed = await prepareRunResume(store, state, repository, fingerprint, 3);
  let finalChecks = 0;
  const result = await new Orchestrator(store, {
    implement: async () => { assert.fail('Must not replay accepted implementation'); },
    verify: async () => { assert.fail('Must not replay task verification'); },
    review: async () => { assert.fail('Must not replay accepted review'); },
    finalVerify: async () => { finalChecks++; return { passed: true, details: 'Recovered' }; }
  }).execute(resumed, ['T001', 'T002'].map((id, index) => ({ id, title: id, objective: 'Test', scope: 'source.txt', acceptanceCriteria: ['Test'], dependencies: index ? ['T001'] : [], verification: ['test'] })));
  assert.equal(finalChecks, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.tasks.T001.attempts.length, 1);
  assert.equal(result.tasks.T002.attempts.length, 1);
});

for (const targetChange of ['deleted', 'rewritten']) {
  test(`rejects ${targetChange} target history without changing it`, async t => {
    const { repository, state } = await fixture(t);
    const target = state.git!.targetBranch;
    if (targetChange === 'deleted') git(repository, 'branch', '-m', 'renamed-target');
    else {
      // Disposable fixture only: create an unrelated root with the same tree.
      const unrelated = git(repository, 'commit-tree', git(repository, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated root');
      git(repository, 'update-ref', `refs/heads/${target}`, unrelated, state.git!.baseCommit);
    }
    const head = git(repository, 'rev-parse', 'HEAD');
    await assert.rejects(validateRunGitState(state, repository));
    assert.equal(git(repository, 'rev-parse', 'HEAD'), head);
  });
}

test('legacy runs and completed runs are not silently reactivated', async t => {
  const { repository, store, state } = await fixture(t);
  state.status = 'completed';
  await assert.rejects(prepareRunResume(store, state, repository, fingerprint, 3), /already completed/);
  state.git = undefined;
  await assert.rejects(validateRunGitState(state, repository), /legacy runs/);
});

test('blocked, interrupted and error attempts do not exhaust the budget; guidance is recorded with the approval', async t => {
  const { repository, store, state } = await fixture(t);
  state.tasks.T001.status = 'blocked';
  state.tasks.T001.attempts = (['blocked', 'error', 'interrupted', 'blocked'] as const).map((outcome, index) => ({ number: index + 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome }));
  await store.save(state);
  await assert.rejects(prepareRunResume(store, state, repository, fingerprint, 3, 'T001', ' '), /Guidance requires/);
  await assert.rejects(prepareRunResume(store, state, repository, fingerprint, 3, undefined, 'Use JSON.'), /Guidance requires|--retry-task/);
  const resumed = await prepareRunResume(store, state, repository, fingerprint, 3, 'T001', 'Use JSON.');
  assert.equal(resumed.tasks.T001.status, 'repair_pending');
  assert.equal(resumed.tasks.T001.attempts.length, 4);
  assert.deepEqual(resumed.resumptions?.map(r => r.guidance), ['Use JSON.']);
});
