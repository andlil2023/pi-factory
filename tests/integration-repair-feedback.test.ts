import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIntegrationFailureFeedback } from '../src/attempt-feedback.ts';
import { autoReplanCandidate } from '../src/auto-replan.ts';
import type { FactoryRunState, IntegrationAttempt } from '../src/state-store.ts';

function fixture(): FactoryRunState {
  const integration: IntegrationAttempt = {
    number: 3, status: 'blocked', approvedAt: 'now', worktree: 'w', branch: 'b', targetBranch: 'main', targetHead: 'a', sourceHead: 'b',
    verification: { passed: false, details: { checks: [{ command: 'test', passed: false, stdout: 'not ok 1 - broken', logFile: 'failure.log' }] } },
    reviews: [
      { reviewer: 'code', verdict: 'changes_requested', report: { findings: [{ severity: 'blocking', description: 'fix this' }] } },
      { reviewer: 'other', verdict: 'approved', report: { findings: [{ severity: 'blocking', description: 'ignore this' }] } }
    ],
    uiEvidence: { passed: false, directory: 'd', artifacts: [], issues: [], manifest: { checks: [
      { kind: 'interaction', name: 'dialog', status: 'failed', details: 'missing' },
      { kind: 'accessibility', name: 'label', status: 'passed' }
    ] } as never }
  };
  return { version: 1, runId: 'r', repository: '.', createdAt: '', updatedAt: '', status: 'blocked', plan: {},
    integrations: [integration], integrationRepairs: [{ at: '', taskId: 'T002', integrationAttempt: 3 }],
    tasks: { T002: { id: 'T002', status: 'blocked', lastError: 'Maximum attempts reached', attempts: [] } } };
}

test('integration feedback selects rejected candidate checks, findings and UI issues', () => {
  const feedback = buildIntegrationFailureFeedback(fixture(), 'T002');
  assert.equal(feedback.open.attempt, 3);
  assert.match(feedback.open.reason, /Integration.*rejected/);
  assert.match(feedback.notes[0], /merged result/);
  assert.equal(feedback.open.failedChecks[0].logFile, 'failure.log');
  assert.deepEqual(feedback.open.failedChecks[0].failures, ['not ok 1 - broken']);
  assert.deepEqual(feedback.open.findings.map(f => f.description), ['fix this']);
  assert.deepEqual(feedback.open.uiEvidenceIssues, ['Failed interaction check "dialog": missing']);
});

test('crashes and timeouts retain integration items; a repair rejection replaces them', () => {
  const state = fixture();
  state.tasks.T002.attempts = [{ number: 1, startedAt: '', outcome: 'error', infraRetry: { role: 'implementer', error: 'timed out' } },
    { number: 2, startedAt: '', outcome: 'interrupted' }];
  const feedback = buildIntegrationFailureFeedback(state, 'T002');
  assert.equal(feedback.open.failedChecks[0].command, 'test');
  assert.equal(feedback.open.findings[0].description, 'fix this');
  assert.equal(feedback.history.length, 2);
  assert.ok(feedback.notes.some(note => /timed out/.test(note)));
  state.tasks.T002.attempts.push({ number: 3, startedAt: '', outcome: 'implemented', verification: { passed: false, details: { checks: [{ command: 'new', passed: false }] } } });
  assert.equal(buildIntegrationFailureFeedback(state, 'T002').open.failedChecks[0].command, 'new');
});

test('integration repairs are never automatic replan candidates', () => {
  const state = fixture();
  state.tasks.T002.attempts = [{ number: 1, startedAt: '', finishedAt: '', outcome: 'implemented' }];
  assert.equal(autoReplanCandidate(state, 1, 2), undefined);
  state.integrationRepairs = [];
  assert.deepEqual(autoReplanCandidate(state, 1, 2), { taskId: 'T002', reason: 'budget_exhausted' });
});
