import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StateStore, type VerificationProgress } from '../src/state-store.ts';
import { Orchestrator, type PlannedTask } from '../src/orchestrator.ts';
import { createAgentAdapters } from '../src/agent-adapters.ts';

const task: PlannedTask = { id: 'T001', title: 'test', objective: '', scope: '', acceptanceCriteria: [], dependencies: [], verification: [] };
const model = { provider: 'test', model: 'test' };

test('final checks persist safe live progress, failure, and a clean retry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'final-progress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const state = await store.create(dir, {}, [task.id], 'progress');
  state.tasks.T001.status = 'completed';
  const adapter = createAgentAdapters({ repository: dir, factoryRoot: resolve('.'), implementer: model, reviewer: model,
    verification: [
      { executable: process.execPath, args: ['-e', 'console.log("SECRET_OUTPUT")'] },
      { executable: process.execPath, args: ['-e', 'process.exit(1)'] }
    ], baselineCommit: 'HEAD' });
  const snapshots: Array<VerificationProgress & { startedAt?: string }> = [];
  let calls = 0;
  const starts: string[] = [];
  const orchestrator = new Orchestrator(store, {
    implement: async () => { throw new Error('unexpected'); },
    verify: adapter.verify,
    review: async () => [],
    finalVerify: async onProgress => {
      calls++;
      const initial = await store.load(state.runId);
      const startedAt = initial.finalVerificationProgress?.startedAt;
      assert.ok(startedAt && Number.isFinite(Date.parse(startedAt)));
      starts.push(startedAt);
      assert.deepEqual(initial.finalVerificationProgress, { mode: 'full', completed: 0, total: 0, failed: 0, status: 'running', checks: [], startedAt });
      assert.equal(initial.finalVerification, undefined);
      if (calls === 2) return { passed: true, details: {} };
      return adapter.verify({ task, attempt: 1, previousFeedback: [], fullVerification: true, finalVerificationProgress: true, onVerificationProgress: async progress => {
        await onProgress(progress);
        snapshots.push((await store.load(state.runId)).finalVerificationProgress!);
      } });
    }
  });
  await orchestrator.execute(state, [task]);
  assert.equal((await store.load(state.runId)).finalVerificationProgress?.status, 'failed');
  assert.ok(snapshots.some(p => p.currentCheck === 1 && p.completed === 0));
  assert.ok(snapshots.some(p => p.currentCheck === 2 && p.completed === 1 && p.checks?.[0].passed));
  assert.deepEqual(snapshots.at(-1)?.checks, [{ ordinal: 1, passed: true }, { ordinal: 2, passed: false }]);
  assert.doesNotMatch(JSON.stringify(snapshots), /SECRET_OUTPUT|process\.exit|console\.log/);
  assert.ok(snapshots.every(p => p.startedAt === starts[0]));
  state.finalVerificationProgress!.startedAt = '2000-01-01T00:00:00.000Z';
  await orchestrator.execute(state, [task]);
  assert.notEqual(starts[1], '2000-01-01T00:00:00.000Z');
  assert.deepEqual((await store.load(state.runId)).finalVerificationProgress, { mode: 'full', completed: 0, total: 0, failed: 0, status: 'passed', checks: [], startedAt: starts[1] });
});

test('recovery marks an active final verification interrupted and keeps completed evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'final-recover-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const state = await store.create(dir, {}, [task.id], 'recover');
  state.status = 'running';
  state.tasks.T001.status = 'completed';
  state.finalVerificationProgress = { mode: 'full', completed: 1, total: 2, failed: 0, status: 'running', currentCheck: 2, checks: [{ ordinal: 1, passed: true }] };
  await store.save(state);
  const recovered = await store.recover(state.runId);
  assert.equal(recovered.status, 'paused');
  assert.deepEqual(recovered.finalVerificationProgress, { mode: 'full', completed: 1, total: 2, failed: 0, status: 'interrupted', checks: [{ ordinal: 1, passed: true }] });
  assert.deepEqual((await store.load(state.runId)).finalVerificationProgress, recovered.finalVerificationProgress);
});
