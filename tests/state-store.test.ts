import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.ts';

test('creates and loads a run with pending tasks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-factory-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const created = await store.create(dir, { objective: 'Calculator' }, ['T001', 'T002'], 'run-1');
  const loaded = await store.load('run-1');
  assert.deepEqual(loaded, created);
  assert.equal(loaded.tasks.T001.status, 'pending');
});

test('persists changes and recovers interrupted attempts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-factory-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const state = await store.create(dir, {}, ['T001'], 'run-2');
  state.status = 'running';
  state.tasks.T001.status = 'running';
  state.tasks.T001.attempts.push({ number: 1, startedAt: new Date().toISOString() });
  await store.save(state);
  const recovered = await store.recover('run-2');
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.tasks.T001.status, 'blocked');
  assert.equal(recovered.tasks.T001.attempts[0].outcome, 'interrupted');
});

test('rejects duplicate run IDs and duplicate task IDs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-factory-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  await assert.rejects(store.create(dir, {}, ['T001', 'T001'], 'dup'));
  await store.create(dir, {}, ['T001'], 'dup');
  await assert.rejects(store.create(dir, {}, ['T002'], 'dup'));
});
