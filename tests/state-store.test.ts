import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

test('persists exact specification metadata through creation and subsequent saves', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-factory-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const text = '# Spécification\r\n\r\n  exact text\n\n';
  const specification = {
    store: 'github' as const, id: '42', url: 'https://example.com/spec/42',
    sha256: createHash('sha256').update(text).digest('hex'), fetchedAt: '2025-01-02T03:04:05.000Z', text
  };
  const created = await store.create(dir, {}, ['T001'], 'spec-run', { specification });
  assert.deepEqual(created.specification, specification);
  const loaded = await store.load('spec-run');
  assert.deepEqual(loaded.specification, specification);
  loaded.status = 'paused';
  await store.save(loaded);
  assert.deepEqual((await store.load('spec-run')).specification, specification);

  const local = { ...specification, store: 'local' as const, id: 'local-id' };
  const { url: _url, ...withoutUrl } = local;
  await store.create(dir, {}, ['T001'], 'local-run', { specification: withoutUrl });
  assert.deepEqual((await store.load('local-run')).specification, withoutUrl);
});

test('loads legacy state without specification metadata', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-factory-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const state = await store.create(dir, {}, ['T001'], 'legacy');
  await writeFile(join(store.directory, 'legacy.json'), JSON.stringify(state));
  const loaded = await store.load('legacy');
  assert.equal(loaded.specification, undefined);
  assert.deepEqual(loaded, state);
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
