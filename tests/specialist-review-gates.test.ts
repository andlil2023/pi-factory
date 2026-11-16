import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, type PlannedTask, type ReviewResult } from '../src/orchestrator.ts';
import { StateStore } from '../src/state-store.ts';
import { requiredReviewerIds } from '../src/agent-adapters.ts';

const task: PlannedTask = { id: 'T001', title: 'Test', objective: 'Test', scope: 'Test', acceptanceCriteria: ['Test'], dependencies: [], verification: ['test'] };
const model = { provider: 'test', model: 'test' };
for (const specialist of ['security', 'ui'] as const) {
  for (const verdict of ['changes_requested', 'blocked'] as const) {
    test(`${specialist} ${verdict} cannot be overridden by other approvals`, async t => {
      const dir = await mkdtemp(join(tmpdir(), 'factory-specialist-gate-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const store = new StateStore(dir);
      const state = await store.create(dir, {}, [task.id], 'test-run');
      let calls = 0;
      const requiredReviewers = requiredReviewerIds({ security: model, ui: model });
      const result = await new Orchestrator(store, {
        implement: async context => {
          calls++;
          if (context.attempt === 2) assert.ok(context.previousFeedback.some(report => (report as { specialist?: string }).specialist === specialist));
          return { outcome: 'implemented', report: {} };
        },
        verify: async () => ({ passed: true, details: {} }),
        review: async context => requiredReviewers.map(reviewer => ({
          reviewer, verdict: reviewer === specialist && context.attempt === 1 ? verdict : 'approved', report: { specialist: reviewer }
        } satisfies ReviewResult))
      }, { requiredReviewers }).execute(state, [task]);
      assert.equal(result.status, verdict === 'blocked' ? 'blocked' : 'completed');
      assert.equal(calls, verdict === 'blocked' ? 1 : 2);
      assert.equal((await store.load('test-run')).tasks.T001.attempts[0].reviews?.length, 3);
    });
  }
}
