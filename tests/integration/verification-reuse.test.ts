import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentAdapters } from '../../src/agent-adapters.ts';
import { StateStore } from '../../src/state-store.ts';
import { createWorktree } from '../../src/git-worktree.ts';
import { createGitCheckpoint } from '../../src/git-checkpoint.ts';
import { captureRunGitState } from '../../src/run-recovery.ts';
import { prepareIntegration, publishIntegration, type IntegrationOptions } from '../../src/git-integration.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
async function fixture(t: import('node:test').TestContext, reuseVerification: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-reuse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = join(dir, 'project');
  await mkdir(repository);
  git(repository, 'init'); git(repository, 'config', 'user.name', 'Test'); git(repository, 'config', 'user.email', 'test@example.invalid'); git(repository, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repository, '.gitignore'), '.factory/\n');
  await writeFile(join(repository, 'source.txt'), 'base\n');
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'initial');
  const info = await createWorktree({ repository, runId: 'run-reuse', worktreesDirectory: join(dir, 'worktrees') });
  const store = new StateStore(repository);
  const state = await store.create(repository, {}, ['T001'], 'run-reuse', { git: await captureRunGitState(info), execution: { maxAttempts: 3, configurationFingerprint: 'fixture-config' } });
  await writeFile(join(info.path, 'factory.txt'), 'factory change\n');
  const checkpoint = await createGitCheckpoint({ worktree: info.path, branch: info.branch, taskId: 'T001', title: 'Accepted task', expectedHead: info.baseCommit });
  state.git!.expectedHead = checkpoint.commit;
  state.tasks.T001 = { id: 'T001', status: 'completed', checkpointCommit: checkpoint.commit, attempts: [{ number: 1, startedAt: new Date().toISOString(), checkpointCommit: checkpoint.commit }] };
  state.status = 'completed';
  state.finalVerification = { passed: true, details: {}, checkedAt: new Date().toISOString() };
  await store.save(state);
  let verified = 0, setups = 0;
  const options: IntegrationOptions = {
    configurationFingerprint: 'fixture-config', enabledReviewers: ['code'], reuseVerification,
    task: { id: 'T000', title: 'Integration', objective: 'Integrate', scope: 'Cumulative', acceptanceCriteria: ['Works'], dependencies: [], verification: ['test'] },
    setup: async () => { setups++; },
    adapters: () => ({
      implement: async () => { assert.fail('Integration must not invoke an implementer'); },
      verify: async () => { verified++; return { passed: true, details: {} }; },
      review: async context => (context.requiredReviewers ?? []).map(reviewer => ({ reviewer, verdict: 'approved', report: {} }))
    })
  };
  return { repository, info, store, state, options, counts: () => ({ verified, setups }) };
}

test('preparation always verifies in its fresh worktree; publication reuses that result for the same tree', async t => {
  const { repository, store, state, options, counts } = await fixture(t, true);
  const record = await prepareIntegration(store, state, options);
  assert.equal(record.status, 'ready', record.error);
  // The run worktree's ignored files are not described by a Git tree, so the clean-checkout verification is never skipped.
  assert.deepEqual(counts(), { verified: 1, setups: 1 });
  assert.equal((record.verification!.details as { reused?: unknown }).reused, undefined);
  assert.equal(record.verifiedTree, git(record.worktree, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(record.reviews?.length, 1);
  const published = await publishIntegration(store, state, options, record.commit!);
  assert.equal(published.status, 'published', published.error);
  assert.equal(counts().verified, 1, 'publication does not run the commands again on the tree preparation verified');
  const details = published.publicationVerification!.details as { reused: { from: string; tree: string } };
  assert.deepEqual([details.reused.from, details.reused.tree], ['integration verification', record.verifiedTree]);
  assert.equal(await readFile(join(repository, 'factory.txt'), 'utf8'), 'factory change\n');
});

test('publication verifies again when reuse is off or no verified tree was recorded', async t => {
  const disabled = await fixture(t, false);
  const first = await prepareIntegration(disabled.store, disabled.state, disabled.options);
  assert.equal(first.status, 'ready', first.error);
  await publishIntegration(disabled.store, disabled.state, disabled.options, first.commit!);
  assert.equal(disabled.counts().verified, 2);

  const legacy = await fixture(t, true);
  const prepared = await prepareIntegration(legacy.store, legacy.state, legacy.options);
  delete prepared.verifiedTree;
  await legacy.store.save(legacy.state);
  await publishIntegration(legacy.store, legacy.state, legacy.options, prepared.commit!);
  assert.equal(legacy.counts().verified, 2, 'a candidate prepared before trees were recorded is verified at publication');
});

test('the full-verification flag overrides task selection and the implementer learns its time limit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-full-flag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  git(repo, 'init'); git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  await mkdir(join(repo, 'a')); await writeFile(join(repo, 'a', 'one'), 'x');
  const capture = join(dir, 'prompt.txt');
  const agent = join(dir, 'agent.mjs');
  await writeFile(agent, `import { writeFileSync } from 'node:fs';let p='';process.stdin.setEncoding('utf8');for await (const c of process.stdin) p+=c;writeFileSync(${JSON.stringify(capture)},p);
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({taskId:'T001',outcome:'implemented',summary:'ok',filesChanged:[],verification:[],blockers:[]})}]}}));`);
  const model = { provider: 'test', model: 'test' };
  const verification = [{ executable: process.execPath, args: ['-e', '0'] }, { executable: process.execPath, args: ['-e', '1-1'] }];
  const adapters = createAgentAdapters({ repository: repo, factoryRoot: resolve('.'), piExecutable: process.execPath, piExecutableArgs: [agent],
    implementer: { ...model, timeoutMs: 600_000 }, reviewer: model, verification, baselineCommit: baseline,
    verificationSelection: { rules: [{ path: 'a', commands: [0] }], dependencyPaths: [], dependenciesComprehensive: true } });
  const context = { task: { id: 'T001', title: 't', objective: 't', scope: 't', acceptanceCriteria: ['t'], dependencies: [], verification: ['t'] }, attempt: 1, previousFeedback: [] };
  const selected = await adapters.verify(context);
  assert.deepEqual([(selected.details as { mode: string }).mode, (selected.details as { checks: unknown[] }).checks.length], ['selected', 1]);
  const full = await adapters.verify({ ...context, fullVerification: true });
  assert.deepEqual([(full.details as { mode: string }).mode, (full.details as { checks: unknown[] }).checks.length], ['full', 2]);
  await adapters.implement(context);
  const prompt = await readFile(capture, 'utf8');
  assert.match(prompt, /Session time limit: 10 minutes/);
  assert.match(prompt, /The factory runs these itself after your session; do not run them/);
});
