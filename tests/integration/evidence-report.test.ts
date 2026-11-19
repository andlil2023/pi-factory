import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentAdapters } from '../../src/agent-adapters.ts';
import { Orchestrator, type PlannedTask } from '../../src/orchestrator.ts';
import { StateStore } from '../../src/state-store.ts';
import { implementationIdentity, planIdentity } from '../../src/verification-observations.ts';
import { buildEvidenceReport } from '../../src/evidence-report.ts';

test('real named verification is persisted with revision-bound criterion results', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'factory-report-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, '.gitignore'), '.factory/\n');
  await writeFile(join(repo, 'source'), 'initial');
  git('add', '.'); git('commit', '-m', 'initial');
  const task: PlannedTask = { id: 'T001', title: 'Change', objective: 'Change', scope: 'Change', acceptanceCriteria: ['Named check passes', 'No observation', 'Stale observation', 'Unrelated observation', 'Failure', 'Ambiguous'], criterionChecks: [
    { criterion: 0, checks: ['good'] }, { criterion: 1, checks: ['missing'] }, { criterion: 2, checks: ['stale'] }, { criterion: 3, checks: ['other'] }, { criterion: 4, checks: ['bad'] }, { criterion: 5, checks: ['duplicate'] }
  ], dependencies: [], verification: ['check'] };
  const plan = { objective: 'Change the implementation.', tasks: [task] };
  const store = new StateStore(repo);
  const state = await store.create(repo, plan, [task.id], 'report-test');
  const model = { provider: 'test', model: 'test' };
  const adapter = createAgentAdapters({ repository: repo, factoryRoot: resolve('.'), implementer: model, reviewer: model,
    verification: [{ name: 'good', executable: process.execPath, args: ['-e', 'process.exit(0)'] }, { name: 'bad', executable: process.execPath, args: ['-e', 'process.exit(1)'] }, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
    baselineCommit: git('rev-parse', 'HEAD'), verificationContext: () => ({ plan: state.plan, specification: null }) });
  const context = { task, attempt: 1, previousFeedback: [] };
  const result = await adapter.verify(context);
  const details = result.details as { observations: Array<{ name: string; passed: boolean; identity: { plan: string; specification: string | null; implementation: string } | null }> };
  assert.deepEqual(details.observations.map(o => o.name), ['good', 'bad']);
  const identity = details.observations[0].identity!;
  details.observations.push({ name: 'stale', passed: true, identity: { ...identity, implementation: 'old' } },
    { name: 'unrelated', passed: true, identity },
    { name: 'duplicate', passed: true, identity }, { name: 'duplicate', passed: false, identity });
  const orchestrator = new Orchestrator(store, {
    implement: async () => ({ outcome: 'implemented', report: {} }),
    verify: async () => ({ passed: true, details: {} }),
    review: async () => [{ reviewer: 'code', verdict: 'approved', report: {} }],
    finalVerify: async () => result,
    reportImplementationIdentity: () => implementationIdentity(repo)
  });
  await orchestrator.execute(state, [task]);
  const report = (await store.load(state.runId)).evidenceReport!;
  assert.equal(report.runId, state.runId);
  assert.deepEqual(report.identity, { plan: planIdentity(plan), specification: null, implementation: identity.implementation });
  assert.equal(report.summary, 'Change the implementation.');
  assert.equal(report.verification, 'failed');
  assert.deepEqual(report.criteria.map(c => c.status), ['demonstrated', 'not demonstrated', 'not demonstrated', 'not demonstrated', 'failed', 'not demonstrated']);
  assert.ok(report.criteria.every(c => c.expected && c.observed && c.evidence.length));
  assert.equal(report.gaps.length, 4);
  assert.equal(buildEvidenceReport(state, 'different').criteria[0].status, 'not demonstrated');
  state.tasks.T001.attempts[0].verification = result;
  state.finalVerification = { passed: true, checkedAt: new Date().toISOString(), details: { reused: { from: 'task verification', taskId: 'T001', attempt: 1 } } };
  assert.equal(buildEvidenceReport(state, identity.implementation).criteria[0].status, 'demonstrated');
  state.plan = { ...plan, objective: 'Revised.' };
  assert.equal(buildEvidenceReport(state, identity.implementation).criteria[0].status, 'not demonstrated');
});
