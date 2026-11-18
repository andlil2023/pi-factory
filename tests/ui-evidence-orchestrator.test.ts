import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, type PlannedTask } from '../src/orchestrator.ts';
import { StateStore } from '../src/state-store.ts';
import type { UiEvidenceRecord } from '../src/ui-evidence.ts';

const task: PlannedTask = { id: 'T001', title: 'WPF', objective: 'Change', scope: 'Change', acceptanceCriteria: ['Works'], dependencies: [], verification: ['test'] };
// 'failed' is a collector fault (environment); 'checks-failed' is a result of the work.
for (const mode of ['passed', 'failed', 'checks-failed', 'not-selected'] as const) {
  test(`UI evidence collection ${mode} is enforced and audited independently of agent reports`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-ui-gate-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new StateStore(dir);
    const state = await store.create(dir, {}, [task.id], 'ui-gate');
    const record: UiEvidenceRecord = { passed: mode === 'passed', directory: 'evidence-directory', artifacts: [],
      issues: mode === 'failed' ? ['Missing screenshot'] : mode === 'checks-failed' ? ['UI evidence contains failed checks'] : [],
      ...(mode === 'checks-failed' ? { manifest: { checks: [{ kind: 'interaction', name: 'opens dialog', status: 'failed' }] } as UiEvidenceRecord['manifest'] } : {}) };
    let collected = 0;
    let reviewed = 0;
    const result = await new Orchestrator(store, {
      implement: async context => {
        // Failed checks are repairable work: the next fresh session receives the issues.
        if (context.attempt > 1) assert.deepEqual(context.feedback?.open.uiEvidenceIssues, ['UI evidence contains failed checks', 'Failed interaction check "opens dialog"']);
        return { outcome: 'implemented', report: { claim: 'UI looks fine' } };
      },
      verify: async () => ({ passed: true, details: {} }),
      selectReviewers: async () => ({ requiredReviewers: mode === 'not-selected' ? ['code'] : ['code', 'ui'], changedFiles: [], reasons: [] }),
      collectUiEvidence: async () => { collected++; return record; },
      review: async context => {
        reviewed++;
        const saved = await store.load('ui-gate');
        if (mode === 'passed') {
          assert.deepEqual(context.uiEvidence, record);
          assert.deepEqual(saved.tasks.T001.attempts[0].uiEvidence, record);
        }
        return context.requiredReviewers!.map(reviewer => ({ reviewer, verdict: 'approved', report: {} }));
      }
    }, { requiredReviewers: ['code', 'ui'] }).execute(state, [task]);
    const rejected = mode === 'failed' || mode === 'checks-failed';
    assert.equal(result.status, rejected ? 'blocked' : 'completed');
    assert.equal(collected, mode === 'not-selected' ? 0 : mode === 'checks-failed' ? 3 : 1);
    assert.equal(reviewed, rejected ? 0 : 1);
    if (mode === 'failed') {
      // An environment fault stops for the operator without spending the repair budget.
      assert.match(result.tasks.T001.lastError!, /^Agent\/verification error: UI evidence rejected: Missing screenshot/);
      assert.equal(result.tasks.T001.attempts.length, 1);
      assert.deepEqual((await store.load('ui-gate')).tasks.T001.attempts[0].uiEvidence, record);
    }
    if (mode === 'checks-failed') {
      assert.match(result.tasks.T001.lastError!, /Maximum attempts \(3\) exhausted: UI evidence rejected: UI evidence contains failed checks/);
      assert.equal(result.tasks.T001.attempts.length, 3);
    }
  });
}
