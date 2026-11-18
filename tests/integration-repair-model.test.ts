import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addIntegrationRepair, integrationRepairEligible } from '../src/integration-repair.ts';
import type { FactoryRunState, IntegrationAttempt } from '../src/state-store.ts';

function fixture(): { state: FactoryRunState; attempt: IntegrationAttempt } {
  const attempt: IntegrationAttempt = { number: 1, status: 'blocked', failedPhase: 'verifying', approvedAt: 'now', worktree: 'w', branch: 'b', targetBranch: 'main', targetHead: 'target', sourceHead: 'source', commit: 'merge', verification: { passed: false, details: { secret: 'feedback' } } };
  const task = { id: 'T001', title: 'one', objective: 'one', scope: 'one', acceptanceCriteria: [], dependencies: [], verification: [] };
  return { attempt, state: { version: 1, runId: 'run', repository: '.', createdAt: 'now', updatedAt: 'now', status: 'completed', plan: { tasks: [task] }, tasks: { T001: { id: 'T001', status: 'completed', attempts: [] } }, git: { worktree: 'w', runBranch: 'run', targetBranch: 'main', baseCommit: 'target', expectedHead: 'source' }, execution: { maxAttempts: 3, configurationFingerprint: 'f' }, finalVerification: { passed: true, details: {}, checkedAt: 'now' }, integrations: [attempt] } };
}

test('integration repair eligibility requires actionable persisted rejection and available budgets', () => {
  const { state, attempt } = fixture();
  const eligible = () => integrationRepairEligible(state, attempt, 2);
  assert.equal(eligible(), true);
  assert.equal(integrationRepairEligible(state, attempt, 0), false);
  state.integrationRepairs = [{ at: 'now', taskId: 'T002', integrationAttempt: 1 }]; assert.equal(eligible(), false); delete state.integrationRepairs;
  state.execution!.maxAttempts = 1; assert.equal(eligible(), false); state.execution!.maxAttempts = 3;
  for (const status of ['preparing', 'conflicted', 'ready', 'stale', 'publishing', 'published', 'pr-publishing', 'pr-opened'] as const) { attempt.status = status; assert.equal(eligible(), false, status); }
  attempt.status = 'blocked';
  delete attempt.commit; assert.equal(eligible(), false); attempt.commit = 'merge';
  attempt.targetBranch = 'other'; assert.equal(eligible(), false); attempt.targetBranch = 'main';
  attempt.sourceHead = 'other'; assert.equal(eligible(), false); attempt.sourceHead = 'source';
  state.git!.baseCommit = 'earlier'; assert.equal(eligible(), false, 'target advanced past the run base'); state.git!.baseCommit = 'target';
  state.status = 'running'; assert.equal(eligible(), false); state.status = 'completed';
  attempt.failedPhase = 'setup'; assert.equal(eligible(), false);
  attempt.failedPhase = 'verifying'; attempt.verification!.passed = true; assert.equal(eligible(), false);
  attempt.failedPhase = 'reviewing'; attempt.reviews = [{ reviewer: 'code', verdict: 'approved', report: {} }]; assert.equal(eligible(), false);
  attempt.reviews[0].verdict = 'changes_requested'; assert.equal(eligible(), true);
  attempt.reviews.push({ reviewer: 'ui', verdict: 'blocked', report: {} }); assert.equal(eligible(), false); attempt.reviews.pop();
  attempt.failedPhase = 'collecting_ui_evidence'; attempt.uiEvidence = { passed: false, directory: '', artifacts: [], issues: ['collector crashed'] }; assert.equal(eligible(), false);
  attempt.uiEvidence.manifest = { version: 1, taskId: 'T000', attempt: 1, capturedAt: 'now', sourceFingerprint: 'x', application: { framework: 'x', buildId: 'x' }, checks: [{ kind: 'interaction', name: 'x', status: 'failed' }], artifacts: [], limitations: [] }; assert.equal(eligible(), true);
});

test('eligibility requires a completed run, completed tasks, and passing final verification', () => {
  for (const status of ['planned', 'running', 'paused', 'blocked', 'completed'] as const) {
    const { state, attempt } = fixture();
    state.status = status;
    assert.equal(integrationRepairEligible(state, attempt, 2), status === 'completed', `run ${status}`);
  }
  for (const status of ['pending', 'running', 'needs_review', 'repair_pending', 'blocked', 'completed'] as const) {
    const { state, attempt } = fixture();
    state.tasks.T001.status = status;
    assert.equal(integrationRepairEligible(state, attempt, 2), status === 'completed', `task ${status}`);
  }
  for (const verification of ['missing', 'failed', 'passed'] as const) {
    const { state, attempt } = fixture();
    if (verification === 'missing') delete state.finalVerification;
    else state.finalVerification!.passed = verification === 'passed';
    assert.equal(integrationRepairEligible(state, attempt, 2), verification === 'passed', `final verification ${verification}`);
  }
  const { state, attempt } = fixture();
  state.tasks = {};
  assert.equal(integrationRepairEligible(state, attempt, 2), false, 'empty task set');
});

test('eligibility enforces latest attempt and counts earlier repairs including withdrawals', () => {
  const { state, attempt } = fixture();
  const earlier = { ...structuredClone(attempt), number: 1 };
  attempt.number = 3;
  state.integrations = [earlier, { ...structuredClone(attempt), number: 2 }, attempt];
  state.execution!.maxAttempts = 10;
  assert.equal(integrationRepairEligible(state, earlier, 2), false, 'nonlatest candidate');
  const repair = { at: 'now', taskId: 'T002', integrationAttempt: 1 };
  state.integrationRepairs = [repair];
  assert.equal(integrationRepairEligible(state, attempt, 2), true, 'one remaining repair');
  assert.equal(integrationRepairEligible(state, attempt, 1), false, 'positive budget exhausted');
  state.integrationRepairs.push({ at: 'later', taskId: 'T003', integrationAttempt: 2, withdrawn: true });
  assert.equal(integrationRepairEligible(state, attempt, 2), false, 'withdrawal consumes budget');
  assert.equal(integrationRepairEligible(state, attempt, 3), true, 'budget above count');
  state.integrationRepairs = [{ ...repair, integrationAttempt: 3 }];
  assert.equal(integrationRepairEligible(state, attempt, 3), false, 'current attempt already repaired');
});

test('review and UI rejections require passing candidate verification', () => {
  for (const phase of ['reviewing', 'collecting_ui_evidence'] as const) {
    for (const verification of ['missing', 'failed', 'passed'] as const) {
      const { state, attempt } = fixture();
      attempt.failedPhase = phase;
      attempt.reviews = [{ reviewer: 'code', verdict: 'changes_requested', report: {} }];
      attempt.uiEvidence = { passed: false, directory: '', artifacts: [], issues: [], manifest: { version: 1, taskId: 'T000', attempt: 1, capturedAt: 'now', sourceFingerprint: 'x', application: { framework: 'x', buildId: 'x' }, checks: [{ kind: 'interaction', name: 'x', status: 'failed' }], artifacts: [], limitations: [] } };
      if (verification === 'missing') delete attempt.verification;
      else attempt.verification!.passed = verification === 'passed';
      assert.equal(integrationRepairEligible(state, attempt, 2), verification === 'passed', `${phase}: ${verification}`);
    }
  }
});

test('integration repair creates an isolated revision with fresh ID and no copied feedback', () => {
  const { state, attempt } = fixture();
  (state.plan as { tasks: Array<{ id: string }> }).tasks.push({ id: 'T005' });
  state.supersededTasks = [{ supersededAt: 'before', task: { id: 'T010', status: 'blocked', attempts: [] } }];
  const before = structuredClone(state);
  const result = addIntegrationRepair(state, attempt, 2, 'later');
  assert.deepEqual(state, before);
  assert.deepEqual(result.integrations, before.integrations);
  assert.deepEqual(result.planRevisions, [{ replacedAt: 'later', plan: before.plan }]);
  assert.deepEqual(result.integrationRepairs, [{ at: 'later', taskId: 'T011', integrationAttempt: 1 }]);
  assert.deepEqual(result.tasks.T011, { id: 'T011', status: 'pending', attempts: [] });
  assert.equal(result.status, 'paused', 'a snapshot with a pending task must be resumable');
  const added = (result.plan as { tasks: Array<{ id: string; dependencies?: string[] }> }).tasks.at(-1)!;
  assert.equal(added.id, 'T011'); assert.deepEqual(added.dependencies, ['T001', 'T005']);
  assert.equal(JSON.stringify(result.integrationRepairs).includes('feedback'), false);
});
