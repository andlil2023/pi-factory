import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Local-machine exclusivity. A live lock is never stolen, even with explicit recovery. */
export async function acquireRunLock(directory: string, runId: string, recoverStale = false): Promise<() => Promise<void>> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run ID');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${runId}.lock`);
  const recoveryPath = `${path}.recovery`;
  const assertNoRecovery = async () => {
    try { await lstat(recoveryPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new Error('Run recovery sentinel exists; inspect active or orphaned recovery before proceeding');
  };
  await assertNoRecovery();
  const token = randomUUID();
  const claim = async (recovering = false) => {
    const handle = await open(path, 'wx');
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
    finally { await handle.close(); }
    if (!recovering) {
      try { await assertNoRecovery(); }
      catch (error) { await unlink(path); throw error; }
    }
  };
  try {
    await claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!recoverStale) throw new Error('Run is locked; if its process has stopped, inspect it and use --recover-lock');
    // Serialize stale-lock recovery so two recoverers cannot delete a new owner's lock.
    const recovery = await open(recoveryPath, 'wx');
    try {
      const previous = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
      if (!Number.isSafeInteger(previous.pid) || (previous.pid as number) <= 0) throw new Error('Invalid run lock; inspect it manually');
      let alive = true;
      try { process.kill(previous.pid as number, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        else throw new Error('Cannot establish that the lock owner stopped; refusing recovery');
      }
      if (alive) throw new Error('Run lock owner is still alive; refusing recovery');
      await unlink(path);
      await claim(true);
    } finally {
      await recovery.close();
      await unlink(recoveryPath);
    }
  }
  return async () => {
    const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
    if (current.token !== token) throw new Error('Run lock ownership changed; refusing to release');
    await unlink(path);
  };
}
