import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.ts';

function errorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test('save retries transient rename failures using the same complete snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'state-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let attempts = 0;
  const snapshots: string[] = [];
  const store = new StateStore(dir, async (source, destination) => {
    attempts++;
    snapshots.push(await readFile(source, 'utf8'));
    if (attempts <= 2) throw errorWithCode('EPERM');
    await rename(source, destination);
  });
  const state = await store.create(dir, { objective: 'test' }, ['T001'], 'retry');
  state.updatedAt = 'old';
  state.status = 'running';
  await store.save(state);
  assert.equal(attempts, 3);
  assert.equal(new Set(snapshots).size, 1);
  assert.deepEqual(JSON.parse(snapshots[0]), state);
  assert.deepEqual(await store.load('retry'), state);
  assert.notEqual(state.updatedAt, 'old');
  assert.deepEqual(await readdir(store.directory), ['retry.json']);
});

test('save exhausts five EBUSY attempts, preserves the error and cleans up', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'state-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const errors = Array.from({ length: 5 }, () => errorWithCode('EBUSY'));
  let attempts = 0;
  const store = new StateStore(dir, async () => { throw errors[attempts++]; });
  const state = await store.create(dir, {}, ['T001'], 'busy');
  state.updatedAt = 'old';
  await assert.rejects(store.save(state), error => error === errors[4]);
  assert.equal(attempts, 5);
  assert.equal(state.updatedAt, 'old');
  assert.deepEqual(await readdir(store.directory), ['busy.json']);
});

test('save does not retry non-transient rename errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'state-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const failure = errorWithCode('ENOSPC');
  let attempts = 0;
  const store = new StateStore(dir, async () => { attempts++; throw failure; });
  const state = await store.create(dir, {}, ['T001'], 'full');
  state.updatedAt = 'old';
  await assert.rejects(store.save(state), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(state.updatedAt, 'old');
  assert.deepEqual(await readdir(store.directory), ['full.json']);
});
