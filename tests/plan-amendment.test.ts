import test from 'node:test';
import assert from 'node:assert/strict';
import { amendRunPlan } from '../src/plan-amendment.ts';
import type { FactoryRunState } from '../src/state-store.ts';
import type { PlannedTask } from '../src/orchestrator.ts';

const task = (id: string, dependencies: string[] = [], title = `Task ${id}`): PlannedTask =>
  ({ id, title, objective: 'O', scope: 'S', acceptanceCriteria: ['A'], dependencies, verification: ['V'] });
const planOf = (tasks: PlannedTask[]) => ({ objective: 'Demo', assumptions: [], decisions: [], tasks, verification: ['V'] });
const attempt = (outcome: 'blocked' | 'implemented') => ({ number: 1, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', outcome });

/** T001 completed, T002 blocked after one attempt, T003 pending. */
function blockedRun(): FactoryRunState {
  return {
    version: 1, runId: 'run-amend', repository: '/repo', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'blocked', plan: planOf([task('T001'), task('T002', ['T001']), task('T003', ['T002'])]),
    tasks: {
      T001: { id: 'T001', status: 'completed', attempts: [{ ...attempt('implemented'), checkpointCommit: 'abc' }], checkpointCommit: 'abc' },
      T002: { id: 'T002', status: 'blocked', attempts: [attempt('blocked')], lastError: 'task_too_large: Big' },
      T003: { id: 'T003', status: 'pending', attempts: [] }
    }
  };
}
const split = () => planOf([task('T001'), task('T004', ['T001']), task('T005', ['T004']), task('T003', ['T005'])]);

test('replaces a blocked task with new tasks and preserves its attempt history', () => {
  const state = blockedRun();
  const original = structuredClone(state.plan);
  const result = amendRunPlan(state, split(), '2026-02-02T00:00:00.000Z');
  assert.deepEqual(result, { superseded: ['T002'], added: ['T004', 'T005'] });
  assert.deepEqual(Object.keys(state.tasks), ['T001', 'T004', 'T005', 'T003']);
  assert.deepEqual(state.tasks.T004, { id: 'T004', status: 'pending', attempts: [] });
  assert.equal(state.tasks.T001.checkpointCommit, 'abc');
  assert.deepEqual(state.plan, split());
  assert.deepEqual(state.planRevisions, [{ replacedAt: '2026-02-02T00:00:00.000Z', plan: original }]);
  assert.equal(state.supersededTasks?.length, 1);
  assert.equal(state.supersededTasks![0].task.id, 'T002');
  assert.equal(state.supersededTasks![0].task.attempts[0].outcome, 'blocked');
  assert.equal(state.status, 'paused');
});

test('rejects changing or removing a completed task', () => {
  const changed = split();
  changed.tasks[0] = task('T001', [], 'Rewritten');
  assert.throws(() => amendRunPlan(blockedRun(), changed), /Completed task T001/);
  const removed = planOf([task('T004'), task('T003', ['T004'])]);
  assert.throws(() => amendRunPlan(blockedRun(), removed), /Completed task T001/);
});

test('rejects redefining an attempted task under the same ID', () => {
  const plan = planOf([task('T001'), task('T002', ['T001'], 'Smaller'), task('T003', ['T002'])]);
  assert.throws(() => amendRunPlan(blockedRun(), plan), /T002 has attempt history/);
});

test('rejects reusing the ID of a superseded task', () => {
  const state = blockedRun();
  amendRunPlan(state, split());
  const reuse = planOf([task('T001'), task('T004', ['T001']), task('T005', ['T004']), task('T002', ['T005']), task('T003', ['T002'])]);
  assert.throws(() => amendRunPlan(state, reuse), /T002 was superseded/);
});

test('rejects an unchanged plan and runs that are active or finished', () => {
  const state = blockedRun();
  assert.throws(() => amendRunPlan(state, structuredClone(state.plan) as ReturnType<typeof planOf>), /does not change/);
  const running = blockedRun();
  running.tasks.T002.status = 'running';
  assert.throws(() => amendRunPlan(running, split()), /recover/i);
  const completed = blockedRun();
  completed.status = 'completed';
  assert.throws(() => amendRunPlan(completed, split()), /completed/);
});

test('a failed amendment leaves the run state untouched', () => {
  const state = blockedRun();
  const before = structuredClone(state);
  const changed = split();
  changed.tasks[0] = task('T001', [], 'Rewritten');
  assert.throws(() => amendRunPlan(state, changed));
  assert.deepEqual(state, before);
});
