import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentAdapters } from '../../src/agent-adapters.ts';
import { Orchestrator, type PlannedTask } from '../../src/orchestrator.ts';
import { StateStore } from '../../src/state-store.ts';
import { implementationIdentity } from '../../src/verification-observations.ts';

test('rerun chains produce persisted failed and flaky-passing criterion results', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-rerun-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const { mkdir } = await import('node:fs/promises'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init'); await writeFile(join(repo, '.gitignore'), '.factory/\n'); git('add', '.gitignore'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'init');
  const task: PlannedTask = { id: 'T001', title: 'Change', objective: 'Change', scope: 'Change', acceptanceCriteria: ['Always fails', 'Eventually passes'], criterionChecks: [{ criterion: 0, checks: ['bad'] }, { criterion: 1, checks: ['flaky'] }], dependencies: [], verification: [] };
  const store = new StateStore(repo); const state = await store.create(repo, { objective: 'Change.', tasks: [task] }, [task.id], 'reruns');
  const model = { provider: 'test', model: 'test' };
  const flag = join(root, 'flag');
  const adapter = createAgentAdapters({ repository: repo, factoryRoot: resolve('.'), implementer: model, reviewer: model, baselineCommit: git('rev-parse', 'HEAD'), verificationReruns: 1,
    verificationContext: () => ({ plan: state.plan, specification: null }), verification: [
      { name: 'bad', executable: process.execPath, args: ['-e', 'process.exit(1)'] },
      { name: 'flaky', executable: process.execPath, args: ['-e', `const fs=require('fs'); if(!fs.existsSync(${JSON.stringify(flag)})){fs.writeFileSync(${JSON.stringify(flag)},'x');process.exit(1)}`] }
    ] });
  const result = await adapter.verify({ task, attempt: 1, previousFeedback: [] });
  await new Orchestrator(store, { implement: async () => ({ outcome: 'implemented', report: {} }), verify: async () => ({ passed: true, details: {} }), review: async () => [{ reviewer: 'code', verdict: 'approved', report: {} }], finalVerify: async () => result, reportImplementationIdentity: () => implementationIdentity(repo) }).execute(state, [task]);
  const report = (await store.load(state.runId)).evidenceReport!;
  assert.deepEqual(report.criteria.map(c => c.status), ['failed', 'demonstrated']);
  const observations = (result.details as { observations: Array<{ execution: { commandIndex: number; rerun: number } }> }).observations;
  assert.deepEqual(observations.map(o => o.execution), [{ commandIndex: 0, rerun: 0 }, { commandIndex: 0, rerun: 1 }, { commandIndex: 1, rerun: 0 }, { commandIndex: 1, rerun: 1 }]);
});
