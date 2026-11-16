import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, type PlannedTask } from '../src/orchestrator.ts';
import { StateStore } from '../src/state-store.ts';
import type { UiEvidenceRecord } from '../src/ui-evidence.ts';

const task: PlannedTask = { id: 'T001', title: 'WPF', objective: 'Change', scope: 'Change', acceptanceCriteria: ['Works'], dependencies: [], verification: ['test'] };
for (const mode of ['passed', 'failed', 'not-selected'] as const) {
  test(`UI evidence collection ${mode} is enforced and audited independently of agent reports`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-ui-gate-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new StateStore(dir);
    const state = await store.create(dir, {}, [task.id], 'ui-gate');
    const record: UiEvidenceRecord = { passed: mode === 'passed', directory: 'evidence-directory', artifacts: [], issues: mode === 'failed' ? ['Missing screenshot'] : [] };
    let collected = 0;
    let reviewed = 0;
    const result = await new Orchestrator(store, {
      implement: async () => ({ outcome: 'implemented', report: { claim: 'UI looks fine' } }),
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
    assert.equal(result.status, mode === 'failed' ? 'blocked' : 'completed');
    assert.equal(collected, mode === 'not-selected' ? 0 : 1);
    assert.equal(reviewed, mode === 'failed' ? 0 : 1);
    if (mode === 'failed') {
      assert.match(result.tasks.T001.lastError!, /UI evidence rejected: Missing screenshot/);
      assert.deepEqual((await store.load('ui-gate')).tasks.T001.attempts[0].uiEvidence, record);
    }
  });
}
