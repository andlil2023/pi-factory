import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, type PlannedTask, type OrchestratorAdapters } from '../src/orchestrator.ts';
import { StateStore } from '../src/state-store.ts';

const task: PlannedTask = { id: 'T001', title: 'Change', objective: 'Change', scope: 'Change', acceptanceCriteria: ['Works'], dependencies: [], verification: ['test'] };
const enabled = ['code', 'security', 'ui'];
async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-routing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const state = await store.create(dir, {}, [task.id], 'routing');
  return { store, state };
}
const base: OrchestratorAdapters = {
  implement: async () => ({ outcome: 'implemented', report: {} }),
  verify: async () => ({ passed: true, details: {} }),
  review: async context => (context.requiredReviewers ?? []).map(reviewer => ({ reviewer, verdict: 'approved', report: {} }))
};

test('uses per-task selection, saving audit evidence before review starts', async t => {
  const { store, state } = await fixture(t);
  const selection = { requiredReviewers: ['code', 'ui'], changedFiles: ['styles/main.css'], reasons: ['UI path'] };
  const result = await new Orchestrator(store, {
    ...base, selectReviewers: async () => selection,
    review: async context => {
      assert.deepEqual(context.requiredReviewers, ['code', 'ui']);
      const saved = await store.load('routing');
      assert.deepEqual(saved.tasks.T001.reviewSelection, selection);
      assert.deepEqual(saved.tasks.T001.attempts[0].reviewSelection, selection);
      return base.review(context, { outcome: 'implemented', report: {} }, { passed: true, details: {} });
    }
  }, { requiredReviewers: enabled }).execute(state, [task]);
  assert.equal(result.status, 'completed');
});

test('repair selection can expand but cannot drop a previous specialist', async t => {
  const { store, state } = await fixture(t);
  const result = await new Orchestrator(store, {
    ...base,
    selectReviewers: async context => ({ requiredReviewers: context.attempt === 1 ? ['code', 'security'] : ['code', 'ui'], changedFiles: context.attempt === 1 ? ['auth/login.ts'] : ['styles/theme.css'], reasons: [String(context.attempt)] }),
    review: async context => {
      assert.deepEqual(context.requiredReviewers, context.attempt === 1 ? ['code', 'security'] : enabled);
      return context.requiredReviewers!.map(reviewer => ({ reviewer, verdict: context.attempt === 1 && reviewer === 'security' ? 'changes_requested' : 'approved', report: {} }));
    }
  }, { requiredReviewers: enabled }).execute(state, [task]);
  assert.equal(result.status, 'completed');
  const saved = await store.load('routing');
  assert.deepEqual(saved.tasks.T001.attempts.map(a => a.reviewSelection?.requiredReviewers), [['code', 'security'], enabled]);
  assert.deepEqual(saved.tasks.T001.reviewSelection?.changedFiles, ['auth/login.ts', 'styles/theme.css']);
});

test('persisted requirements survive reload and cannot be disabled', async t => {
  const { store, state } = await fixture(t);
  state.tasks.T001.reviewSelection = { requiredReviewers: ['code', 'security'], changedFiles: ['auth.ts'], reasons: ['Prior selection'] };
  await store.save(state);
  const reloaded = await store.load('routing');
  let reviewed = false;
  const result = await new Orchestrator(store, {
    ...base, selectReviewers: async () => ({ requiredReviewers: ['code'], changedFiles: ['README.md'], reasons: ['Docs'] }),
    review: async () => { reviewed = true; return []; }
  }, { requiredReviewers: ['code', 'ui'] }).execute(reloaded, [task]);
  assert.equal(result.status, 'blocked');
  assert.equal(reviewed, false);
  assert.match(result.tasks.T001.lastError!, /no longer enabled/);
});

for (const ids of [['security'], ['code', 'typo'], ['code', 'code']]) {
  test(`invalid selection ${ids.join(',')} blocks before invoking reviewers`, async t => {
    const { store, state } = await fixture(t);
    const result = await new Orchestrator(store, {
      ...base, selectReviewers: async () => ({ requiredReviewers: ids, changedFiles: [], reasons: [] }),
      review: async () => { assert.fail('Must not invoke review'); }
    }, { requiredReviewers: enabled }).execute(state, [task]);
    assert.equal(result.status, 'blocked');
    assert.match(result.tasks.T001.lastError!, /Invalid reviewer routing selection/);
  });
}

for (const reported of [['code'], ['code', 'ui', 'security'], ['code', 'ui', 'ui']]) {
  test(`missing, unexpected, or duplicate routed reports block: ${reported.join(',')}`, async t => {
    const { store, state } = await fixture(t);
    const result = await new Orchestrator(store, {
      ...base, selectReviewers: async () => ({ requiredReviewers: ['code', 'ui'], changedFiles: [], reasons: [] }),
      review: async () => reported.map(reviewer => ({ reviewer, verdict: 'approved', report: {} }))
    }, { requiredReviewers: enabled }).execute(state, [task]);
    assert.equal(result.status, 'blocked');
  });
}
