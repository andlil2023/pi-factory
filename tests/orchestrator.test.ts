import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.ts';
import { Orchestrator, type PlannedTask, type OrchestratorAdapters } from '../src/orchestrator.ts';

const tasks: PlannedTask[] = [
  { id: 'T001', title: 'A', objective: 'A', scope: 'A', acceptanceCriteria: ['A'], dependencies: [], verification: ['test'] },
  { id: 'T002', title: 'B', objective: 'B', scope: 'B', acceptanceCriteria: ['B'], dependencies: ['T001'], verification: ['test'] }
];
async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-orch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const state = await store.create(dir, { objective: 'demo' }, tasks.map(t => t.id), 'test-run');
  return { store, state };
}
test('executes dependencies in order and completes only after review', async t => {
  const { store, state } = await fixture(t);
  const calls: string[] = [];
  const adapters: OrchestratorAdapters = {
    implement: async c => { calls.push(`implement:${c.task.id}`); return { outcome: 'implemented', report: {} }; },
    verify: async c => { calls.push(`verify:${c.task.id}`); return { passed: true, details: {} }; },
    review: async c => { calls.push(`review:${c.task.id}`); return [{ reviewer: 'code', verdict: 'approved', report: {} }]; }
  };
  const result = await new Orchestrator(store, adapters).execute(state, tasks);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['implement:T001','verify:T001','review:T001','implement:T002','verify:T002','review:T002']);
  assert.equal((await store.load('test-run')).tasks.T002.status, 'completed');
});
test('review rejection causes a fresh repair attempt with feedback', async t => {
  const { store, state } = await fixture(t);
  let calls = 0;
  const adapters: OrchestratorAdapters = {
    implement: async c => { calls++; if (c.attempt === 2) assert.equal(c.previousFeedback.length, 2); return { outcome: 'implemented', report: {} }; },
    verify: async () => ({ passed: true, details: {} }),
    review: async c => [{ reviewer: 'code', verdict: c.attempt === 1 ? 'changes_requested' : 'approved', report: { finding: 'fix' } }]
  };
  const result = await new Orchestrator(store, adapters).execute(state, tasks);
  assert.equal(result.status, 'completed');
  assert.equal(calls, 4);
  assert.equal(result.tasks.T001.attempts.length, 2);
});
test('loaded plan context reaches every fresh attempt and reviewer without mutating persisted decisions', async t => {
  const { store, state } = await fixture(t);
  const plan = { objective: 'dashboard', assumptions: ['Metadata only'], decisions: [
    { id: 'D001', question: 'Omit raw finding text', blocking: false, affectedTasks: ['T001'] }
  ], tasks, verification: ['Check disclosure policy'] };
  state.plan = structuredClone(plan);
  await store.save(state);
  const loaded = await store.load(state.runId);
  const attempts: string[] = [];
  const result = await new Orchestrator(store, {
    implement: async c => {
      assert.deepEqual(c.plan, plan);
      attempts.push(`${c.task.id}:${c.attempt}`);
      return { outcome: 'implemented', report: {} };
    },
    verify: async () => ({ passed: true, details: {} }),
    review: async c => {
      assert.deepEqual(c.plan, plan);
      // Adapter-local mutations must not change persisted policy or later attempts.
      (c.plan as typeof plan).assumptions.push('adapter mutation');
      return [{ reviewer: 'code', verdict: c.attempt === 1 ? 'changes_requested' : 'approved', report: {} }];
    }
  }).execute(loaded, tasks);
  assert.equal(result.status, 'completed');
  assert.deepEqual(attempts, ['T001:1', 'T001:2', 'T002:1', 'T002:2']);
  assert.deepEqual((await store.load(state.runId)).plan, plan);
});

test('missing required review blocks the run', async t => {
  const { store, state } = await fixture(t);
  const adapters: OrchestratorAdapters = {
    implement: async () => ({ outcome: 'implemented', report: {} }),
    verify: async () => ({ passed: true, details: {} }),
    review: async () => [{ reviewer: 'code', verdict: 'approved', report: {} }]
  };
  const result = await new Orchestrator(store, adapters, { requiredReviewers: ['code', 'security'] }).execute(state, tasks);
  assert.equal(result.status, 'blocked');
  assert.equal(result.tasks.T002.status, 'pending');
});
test('persists each validated review before later reviewer failure', async t => {
  const { store, state } = await fixture(t);
  const result = await new Orchestrator(store, {
    implement: async () => ({ outcome: 'implemented', report: {} }),
    verify: async () => ({ passed: true, details: {} }),
    review: async (_context, _implementation, _verification, onReview) => {
      await onReview!({ reviewer: 'code', verdict: 'approved', report: {} });
      await onReview!({ reviewer: 'security', verdict: 'changes_requested', report: { finding: 'Retain security defect' } });
      const saved = await store.load('test-run');
      assert.equal(saved.tasks.T001.attempts[0].reviews?.length, 2);
      throw new Error('UI reviewer timed out');
    }
  }, { requiredReviewers: ['code', 'security', 'ui'] }).execute(state, tasks);
  assert.equal(result.status, 'blocked');
  const reviews = (await store.load('test-run')).tasks.T001.attempts[0].reviews!;
  assert.deepEqual(reviews.map(review => review.reviewer), ['code', 'security']);
  assert.deepEqual(reviews[1].report, { finding: 'Retain security defect' });
  assert.equal(result.tasks.T002.status, 'pending');
});

test('verification failures exhaust retry budget without review', async t => {
  const { store, state } = await fixture(t);
  let reviews = 0;
  const adapters: OrchestratorAdapters = {
    implement: async () => ({ outcome: 'implemented', report: {} }),
    verify: async () => ({ passed: false, details: { error: 'tests failed' } }),
    review: async () => { reviews++; return []; }
  };
  const result = await new Orchestrator(store, adapters, { maxAttempts: 2 }).execute(state, tasks);
  assert.equal(result.status, 'blocked');
  assert.equal(result.tasks.T001.attempts.length, 2);
  assert.equal(reviews, 0);
});

test('checkpoints approved tasks and verifies final work before completion', async t => {
  const {store,state} = await fixture(t);
  const calls: string[] = [];
  const adapters: OrchestratorAdapters = {
    implement: async c => {calls.push(`implement:${c.task.id}`); return {outcome:'implemented',report:{}};},
    verify: async c => {calls.push(`verify:${c.task.id}`); return {passed:true,details:{}};},
    review: async c => {calls.push(`review:${c.task.id}`); return [{reviewer:'code',verdict:'approved',report:{}}];},
    checkpoint: async c => {calls.push(`checkpoint:${c.task.id}`); return {commit:`sha-${c.task.id}`};},
    finalVerify: async () => {calls.push('finalVerify');return {passed:true,details:{}};}
  };
  const result = await new Orchestrator(store,adapters).execute(state,tasks);
  assert.equal(result.status,'completed');
  assert.equal(result.tasks.T001.checkpointCommit,'sha-T001');
  assert.equal(result.finalVerification?.passed,true);
  assert.deepEqual(calls,['implement:T001','verify:T001','review:T001','checkpoint:T001','implement:T002','verify:T002','review:T002','checkpoint:T002','finalVerify']);
});

test('final verification failure blocks run even after approved task checkpoints', async t => {
  const {store,state} = await fixture(t);
  const adapters: OrchestratorAdapters = {
    implement: async () => ({outcome:'implemented',report:{}}),
    verify: async () => ({passed:true,details:{}}),
    review: async () => ([{reviewer:'code',verdict:'approved',report:{}}]),
    checkpoint: async c => ({commit:`sha-${c.task.id}`}),
    finalVerify: async () => ({passed:false,details:{reason:'regression'}})
  };
  const result = await new Orchestrator(store,adapters).execute(state,tasks);
  assert.equal(result.status,'blocked');
  assert.equal(result.finalVerification?.passed,false);
  assert.equal((await store.load('test-run')).status,'blocked');
});

test('checkpoint failure blocks run and does not mark task complete', async t => {
  const {store,state} = await fixture(t);
  const adapters: OrchestratorAdapters = {
    implement: async () => ({outcome:'implemented',report:{}}),
    verify: async () => ({passed:true,details:{}}),
    review: async () => ([{reviewer:'code',verdict:'approved',report:{}}]),
    checkpoint: async () => {throw new Error('git commit failed');}
  };
  const result = await new Orchestrator(store,adapters).execute(state,tasks);
  assert.equal(result.status,'blocked');
  assert.equal(result.tasks.T001.status,'blocked');
});
