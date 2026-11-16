import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, consumedAttempts } from '../src/state-store.ts';
import { Orchestrator, type PlannedTask, type OrchestratorAdapters } from '../src/orchestrator.ts';

const tasks: PlannedTask[] = [
  { id: 'T001', title: 'A', objective: 'A', scope: 'A', acceptanceCriteria: ['A'], dependencies: [], verification: ['test'] }
];
async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-blocked-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const state = await store.create(dir, { objective: 'demo' }, ['T001'], 'test-run');
  return { store, state };
}
const approve: Pick<OrchestratorAdapters, 'verify' | 'review'> = {
  verify: async () => ({ passed: true, details: {} }),
  review: async () => [{ reviewer: 'code', verdict: 'approved', report: {} }]
};

test('a blocked report does not consume the repair budget', async t => {
  const { store, state } = await fixture(t);
  let calls = 0;
  const adapters: OrchestratorAdapters = {
    ...approve,
    implement: async () => ++calls === 1
      ? { outcome: 'blocked', report: {}, blockers: [{ kind: 'decision_needed', description: 'Two formats', question: 'JSON or CSV?' }] }
      : { outcome: 'implemented', report: {} }
  };
  const orchestrator = new Orchestrator(store, adapters, { maxAttempts: 1 });
  const blocked = await orchestrator.execute(state, tasks);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.tasks.T001.lastError, 'decision_needed: JSON or CSV?');
  assert.equal(consumedAttempts(blocked.tasks.T001), 0);
  // An approved resume re-queues the task; the single budgeted attempt is still available.
  blocked.tasks.T001.status = 'repair_pending';
  const resumed = await orchestrator.execute(blocked, tasks);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.tasks.T001.attempts.length, 2);
});

test('an agent or infrastructure error is recorded as error and does not consume the repair budget', async t => {
  const { store, state } = await fixture(t);
  let calls = 0;
  const adapters: OrchestratorAdapters = {
    ...approve,
    implement: async () => { if (++calls === 1) throw new Error('spawn ENAMETOOLONG'); return { outcome: 'implemented', report: {} }; }
  };
  const orchestrator = new Orchestrator(store, adapters, { maxAttempts: 1 });
  const blocked = await orchestrator.execute(state, tasks);
  assert.equal(blocked.tasks.T001.attempts[0].outcome, 'error');
  assert.equal(consumedAttempts(blocked.tasks.T001), 0);
  blocked.tasks.T001.status = 'repair_pending';
  assert.equal((await orchestrator.execute(blocked, tasks)).status, 'completed');
});

test('rejected work still consumes the repair budget', async t => {
  const { store, state } = await fixture(t);
  const result = await new Orchestrator(store, {
    implement: async () => ({ outcome: 'implemented', report: {} }),
    verify: async () => ({ passed: false, details: {} }),
    review: async () => []
  }, { maxAttempts: 2 }).execute(state, tasks);
  assert.equal(result.tasks.T001.attempts.length, 2);
  assert.equal(consumedAttempts(result.tasks.T001), 2);
  assert.match(result.tasks.T001.lastError!, /Maximum attempts \(2\) exhausted/);
});

test('operator guidance recorded for a retried task reaches the implementer and reviewers', async t => {
  const { store, state } = await fixture(t);
  state.resumptions = [
    { approvedAt: new Date().toISOString(), previousStatus: 'blocked', retryTask: 'T001', guidance: 'Use JSON.' },
    { approvedAt: new Date().toISOString(), previousStatus: 'blocked', retryTask: 'T009', guidance: 'Other task.' }
  ];
  const seen: unknown[] = [];
  const result = await new Orchestrator(store, {
    implement: async c => { seen.push(c.operatorGuidance); return { outcome: 'implemented', report: {} }; },
    verify: async () => ({ passed: true, details: {} }),
    review: async c => { seen.push(c.operatorGuidance); return [{ reviewer: 'code', verdict: 'approved', report: {} }]; }
  }).execute(state, tasks);
  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, [['Use JSON.'], ['Use JSON.']]);
});
