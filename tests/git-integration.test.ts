import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentAdapters } from '../src/agent-adapters.ts';
import { StateStore } from '../src/state-store.ts';
import { createWorktree } from '../src/git-worktree.ts';
import { createGitCheckpoint } from '../src/git-checkpoint.ts';
import { captureRunGitState } from '../src/run-recovery.ts';
import { prepareIntegration, publishIntegration, type IntegrationOptions } from '../src/git-integration.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
async function fixture(t: import('node:test').TestContext, conflict = false) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = join(dir, 'project');
  await mkdir(repository);
  git(repository, 'init');
  git(repository, 'config', 'user.name', 'Test');
  git(repository, 'config', 'user.email', 'test@example.invalid');
  git(repository, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repository, '.gitignore'), '.factory/\n');
  await writeFile(join(repository, 'source.txt'), 'base\n');
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'initial');
  const info = await createWorktree({ repository, runId: 'run-integration', worktreesDirectory: join(dir, 'worktrees') });
  const metadata = await captureRunGitState(info);
  const store = new StateStore(repository);
  const state = await store.create(repository, {}, ['T001'], 'run-integration', { git: metadata, execution: { maxAttempts: 3, configurationFingerprint: 'fixture-config' } });
  await writeFile(join(info.path, conflict ? 'source.txt' : 'factory.txt'), 'factory change\n');
  const checkpoint = await createGitCheckpoint({ worktree: info.path, branch: info.branch, taskId: 'T001', title: 'Accepted task', expectedHead: info.baseCommit });
  state.git!.expectedHead = checkpoint.commit;
  state.tasks.T001.status = 'completed';
  state.tasks.T001.checkpointCommit = checkpoint.commit;
  state.tasks.T001.attempts = [{ number: 1, startedAt: new Date().toISOString(), checkpointCommit: checkpoint.commit }];
  state.status = 'completed';
  state.finalVerification = { passed: true, details: {}, checkedAt: new Date().toISOString() };
  await store.save(state);
  let verified = 0, reviewed = 0;
  const options: IntegrationOptions = {
    configurationFingerprint: 'fixture-config', enabledReviewers: ['code'],
    task: { id: 'T000', title: 'Integration', objective: 'Integrate', scope: 'Cumulative', acceptanceCriteria: ['Works'], dependencies: [], verification: ['test'] },
    adapters: () => ({
      implement: async () => { assert.fail('Integration must not invoke an implementer'); },
      verify: async () => { verified++; return { passed: true, details: {} }; },
      review: async context => { reviewed++; return (context.requiredReviewers ?? []).map(reviewer => ({ reviewer, verdict: 'approved', report: {} })); }
    })
  };
  return { repository, info, store, state, options, counts: () => ({ verified, reviewed }) };
}

test('preparation verifies and reviews a separate merge, publication needs its exact candidate', async t => {
  const { repository, info, store, state, options, counts } = await fixture(t);
  const candidate = await prepareIntegration(store, state, options);
  assert.equal(candidate.status, 'ready', candidate.error);
  assert.equal(git(repository, 'rev-parse', 'HEAD'), info.baseCommit);
  assert.equal(git(info.path, 'rev-parse', 'HEAD'), state.git!.expectedHead);
  assert.deepEqual(git(candidate.worktree, 'rev-list', '--parents', '-n', '1', candidate.commit!).split(' '), [candidate.commit, info.baseCommit, state.git!.expectedHead]);
  await assert.rejects(publishIntegration(store, state, options, 'wrong-sha'), /exact --candidate/);
  assert.equal(candidate.status, 'ready');
  const published = await publishIntegration(store, state, options, candidate.commit!);
  assert.equal(published.status, 'published');
  assert.equal(git(repository, 'rev-parse', 'HEAD'), candidate.commit);
  assert.equal(git(repository, 'status', '--porcelain'), '');
  assert.deepEqual(counts(), { verified: 2, reviewed: 1 });
  assert.equal((await store.load(state.runId)).integrations?.[0].status, 'published');
});

test('merges against the current advanced target rather than the original base', async t => {
  const { repository, store, state, options } = await fixture(t);
  await writeFile(join(repository, 'target-only.txt'), 'target change');
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'target advance');
  const target = git(repository, 'rev-parse', 'HEAD');
  const candidate = await prepareIntegration(store, state, options);
  assert.equal(candidate.status, 'ready', candidate.error);
  assert.equal(candidate.targetHead, target);
  assert.equal(await readFile(join(candidate.worktree, 'target-only.txt'), 'utf8'), 'target change');
  assert.equal(await readFile(join(candidate.worktree, 'factory.txt'), 'utf8'), 'factory change\n');
  assert.equal(git(repository, 'rev-parse', 'HEAD'), target);
});

test('preserves merge conflicts without touching source or target', async t => {
  const { repository, info, store, state, options, counts } = await fixture(t, true);
  await writeFile(join(repository, 'source.txt'), 'target change\n');
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'conflicting target');
  const target = git(repository, 'rev-parse', 'HEAD');
  const record = await prepareIntegration(store, state, options);
  assert.equal(record.status, 'conflicted');
  assert.deepEqual(record.conflicts, ['source.txt']);
  assert.match(await readFile(join(record.worktree, 'source.txt'), 'utf8'), /<<<<<<</);
  assert.ok(git(record.worktree, 'rev-parse', '--verify', 'MERGE_HEAD'));
  assert.equal(git(repository, 'rev-parse', 'HEAD'), target);
  assert.equal(git(info.path, 'rev-parse', 'HEAD'), state.git!.expectedHead);
  assert.deepEqual(counts(), { verified: 0, reviewed: 0 });
  await assert.rejects(publishIntegration(store, state, options, target), /latest ready/);
});

test('failed verification or verification mutations prevent ready status', async t => {
  const { repository, store, state, options, info } = await fixture(t);
  options.adapters = worktree => ({
    implement: async () => { assert.fail(); },
    verify: async () => { await writeFile(join(worktree, 'unexpected.txt'), 'unverified output'); return { passed: true, details: {} }; },
    review: async () => { assert.fail('Must not review mutated source'); }
  });
  const record = await prepareIntegration(store, state, options);
  assert.equal(record.status, 'blocked');
  assert.match(record.error!, /dirty/);
  assert.equal(git(repository, 'rev-parse', 'HEAD'), info.baseCommit);
});

test('review rejection cannot be bypassed by dropping a specialist on a new attempt', async t => {
  const { store, state, options } = await fixture(t);
  options.enabledReviewers = ['code', 'security'];
  options.adapters = () => ({
    implement: async () => { assert.fail(); },
    verify: async () => ({ passed: true, details: {} }),
    selectReviewers: async context => ({ requiredReviewers: context.attempt === 1 ? ['code', 'security'] : ['code'], changedFiles: ['factory.txt'], reasons: ['Fixture selection'] }),
    review: async context => {
      if (context.attempt === 2) {
        assert.deepEqual(context.requiredReviewers, ['code', 'security']);
        assert.ok(context.previousFeedback.some(value => (value as { finding?: string }).finding === 'Fix integration'));
      }
      return context.requiredReviewers!.map(reviewer => ({ reviewer, verdict: context.attempt === 1 && reviewer === 'security' ? 'changes_requested' : 'approved', report: { finding: 'Fix integration' } }));
    }
  });
  const first = await prepareIntegration(store, state, options);
  assert.equal(first.status, 'blocked');
  await assert.rejects(prepareIntegration(store, state, options), /--new-attempt/);
  const second = await prepareIntegration(store, state, options, true);
  assert.equal(second.status, 'ready', second.error);
  assert.notEqual(first.worktree, second.worktree);
  assert.equal(state.integrations?.length, 2);
});

for (const obstruction of ['target-moved', 'candidate-dirty', 'target-dirty', 'publication-tests-failed'] as const) {
  test(`publication refuses ${obstruction} and preserves the target`, async t => {
    const { repository, store, state, options } = await fixture(t);
    const record = await prepareIntegration(store, state, options);
    assert.equal(record.status, 'ready', record.error);
    if (obstruction === 'target-moved') {
      await writeFile(join(repository, 'new-target.txt'), 'advance');
      git(repository, 'add', '.'); git(repository, 'commit', '-m', 'late target advance');
    } else if (obstruction === 'candidate-dirty') await writeFile(join(record.worktree, 'stray.txt'), 'preserve');
    else if (obstruction === 'target-dirty') await writeFile(join(repository, 'source.txt'), 'preserve target edits');
    else options.adapters = () => ({ implement: async () => { assert.fail(); }, verify: async () => ({ passed: false, details: 'Failure' }), review: async () => { assert.fail(); } });
    const target = git(repository, 'rev-parse', 'HEAD');
    await assert.rejects(publishIntegration(store, state, options, record.commit!));
    assert.equal(record.status, 'blocked');
    assert.equal(git(repository, 'rev-parse', 'HEAD'), target);
    assert.equal((await store.load(state.runId)).integrations?.[0].status, 'blocked');
  });
}

test('missing, duplicate and unexpected reviewer reports cannot approve integration', async t => {
  const { store, state, options } = await fixture(t);
  options.enabledReviewers = ['code', 'security'];
  const reports = [['code'], ['code', 'security', 'unexpected'], ['code', 'security', 'security']];
  options.adapters = () => ({
    implement: async () => { assert.fail(); }, verify: async () => ({ passed: true, details: {} }),
    review: async context => reports[context.attempt - 1].map(reviewer => ({ reviewer, verdict: 'approved', report: {} }))
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const record = await prepareIntegration(store, state, options, attempt > 1);
    assert.equal(record.status, 'blocked');
    assert.match(record.error!, /exact, unanimous/);
  }
});

test('failed rendered evidence blocks integration before reviewer invocation', async t => {
  const { store, state, options } = await fixture(t);
  options.enabledReviewers = ['code', 'ui'];
  options.adapters = () => ({
    implement: async () => { assert.fail(); }, verify: async () => ({ passed: true, details: {} }),
    collectUiEvidence: async () => ({ passed: false, directory: 'preserved-evidence', artifacts: [], issues: ['Missing screenshot'] }),
    review: async () => { assert.fail('Must not review missing required evidence'); }
  });
  const record = await prepareIntegration(store, state, options);
  assert.equal(record.status, 'blocked');
  assert.match(record.error!, /UI evidence failed/);
  assert.deepEqual((await store.load(state.runId)).integrations?.[0].uiEvidence?.issues, ['Missing screenshot']);
});

test('target advancement during review makes the candidate stale', async t => {
  const { repository, store, state, options } = await fixture(t);
  const base = options.adapters;
  options.adapters = (...args) => ({ ...base(...args), review: async () => {
    await writeFile(join(repository, 'late-change.txt'), 'external change');
    git(repository, 'add', '.'); git(repository, 'commit', '-m', 'target changed during review');
    return [{ reviewer: 'code', verdict: 'approved', report: {} }];
  } });
  const record = await prepareIntegration(store, state, options);
  assert.equal(record.status, 'stale');
  assert.match(record.error!, /moved/);
  assert.notEqual(git(repository, 'rev-parse', 'HEAD'), record.commit);
});

test('ambiguous publication is preserved for manual reconciliation, never blindly retried', async t => {
  const { repository, store, state, options } = await fixture(t);
  const record = await prepareIntegration(store, state, options);
  assert.equal(record.status, 'ready', record.error);
  // Simulate a crash after the explicit publish approval and Git fast-forward,
  // but before final state acknowledgement. Only this disposable fixture is changed.
  record.status = 'publishing';
  await store.save(state);
  git(repository, 'merge', '--ff-only', '--no-edit', record.commit!);
  const reloaded = await store.load(state.runId);
  await assert.rejects(publishIntegration(store, reloaded, options, record.commit!), /latest ready/);
  await assert.rejects(prepareIntegration(store, reloaded, options, true), /manual reconciliation/);
  assert.equal(git(repository, 'rev-parse', 'HEAD'), record.commit);
});

test('production reviewer partial failure retains blocking findings and sends them to fresh integration reviewers', async t => {
  const { store, state, options } = await fixture(t);
  options.enabledReviewers = ['code', 'security', 'ui'];
  const model = { provider: 'fixture', model: 'fixture' };
  options.adapters = (worktree, baseline, attempt) => createAgentAdapters({
    repository: worktree, factoryRoot: resolve('.'), implementer: model, reviewer: model, reviewers: { security: model, ui: model },
    piExecutable: process.execPath,
    piExecutableArgs: [resolve('tests/fixtures/fake-reviewer.mjs'), attempt === 1 ? 'partial-failure' : 'normal', join(store.directory, `${state.runId}.json`)],
    baselineCommit: baseline, verification: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'] }]
  });
  const failed = await prepareIntegration(store, state, options);
  assert.equal(failed.status, 'blocked');
  assert.match(failed.error!, /Invalid ui review report/);
  const saved = await store.load(state.runId);
  const partial = saved.integrations![0].reviews!;
  assert.deepEqual(partial.map(review => `${review.reviewer}:${review.verdict}`), ['code:approved', 'security:changes_requested']);
  assert.match(JSON.stringify(partial[1].report), /PRIOR_SECURITY_FINDING_7821/);
  // Reloading proves the failed batch's findings survive beyond the original in-memory context.
  const next = await prepareIntegration(store, saved, options, true);
  assert.equal(next.status, 'ready', next.error);
  for (const review of next.reviews!) {
    const { prompt } = JSON.parse((review.report as { summary: string }).summary) as { prompt: string };
    assert.match(prompt, /PRIOR_SECURITY_FINDING_7821/);
  }
  assert.deepEqual(saved.integrations![0].reviews, partial);
});

test('integration attempts are bounded and incomplete runs cannot integrate', async t => {
  const { store, state, options } = await fixture(t);
  state.status = 'blocked';
  await assert.rejects(prepareIntegration(store, state, options), /completed/);
  state.status = 'completed';
  options.adapters = () => ({ implement: async () => { assert.fail(); }, verify: async () => ({ passed: false, details: 'Fixture failure' }), review: async () => { assert.fail(); } });
  for (let attempt = 1; attempt <= 3; attempt++) assert.equal((await prepareIntegration(store, state, options, attempt > 1)).status, 'blocked');
  await assert.rejects(prepareIntegration(store, state, options, true), /budget exhausted/);
});
