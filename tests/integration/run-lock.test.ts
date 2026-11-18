import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunLock } from '../../src/run-lock.ts';

async function fixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('exclusive run lock releases normally and refuses live owner recovery', async t => {
  const directory = await fixture(t);
  const release = await acquireRunLock(directory, 'run-lock');
  await assert.rejects(acquireRunLock(directory, 'run-lock'), /Run is locked/);
  await assert.rejects(acquireRunLock(directory, 'run-lock', true), /still alive/);
  await release();
  const next = await acquireRunLock(directory, 'run-lock');
  await next();
});

test('dead owner recovery requires an explicit flag', async t => {
  const directory = await fixture(t);
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const path = join(directory, 'run-lock.lock');
  await writeFile(path, JSON.stringify({ pid: Number(child.stdout.trim()), token: 'dead-owner' }));
  await assert.rejects(acquireRunLock(directory, 'run-lock'), /--recover-lock/);
  const release = await acquireRunLock(directory, 'run-lock', true);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid);
  await release();
});

test('orphaned recovery sentinel blocks acquisition even when the main lock is missing', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'run-lock.lock');
  const recoveryPath = `${path}.recovery`;
  await writeFile(recoveryPath, 'preserve orphaned recovery');
  for (const recoverStale of [false, true]) {
    await assert.rejects(acquireRunLock(directory, 'run-lock', recoverStale), /recovery sentinel exists/);
    await assert.rejects(lstat(path), { code: 'ENOENT' });
    assert.equal(await readFile(recoveryPath, 'utf8'), 'preserve orphaned recovery');
  }
});

test('competing stale-lock recoverers cannot both become owners', async t => {
  const directory = await fixture(t);
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  await writeFile(join(directory, 'run-lock.lock'), JSON.stringify({ pid: Number(child.stdout.trim()), token: 'dead-owner' }));
  const outcomes = await Promise.allSettled([
    acquireRunLock(directory, 'run-lock', true),
    acquireRunLock(directory, 'run-lock', true)
  ]);
  const winners = outcomes.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  await winners[0].value();
});

test('malformed locks are preserved for inspection', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'run-lock.lock');
  await writeFile(path, JSON.stringify({ pid: -1 }));
  await assert.rejects(acquireRunLock(directory, 'run-lock', true), /Invalid run lock/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { pid: -1 });
  await assert.rejects(acquireRunLock(directory, '../escape'), /Invalid run ID/);
});
