import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { FactoryRunState } from './state-store.ts';

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

/** Fail closed: never reset, clean, checkout or discard files during resume. */
export async function inspectResume(state: FactoryRunState, repository: string): Promise<{worktree: string; head: string}> {
  const root = await realpath(resolve(repository));
  if (resolve(state.repository).toLowerCase() !== root.toLowerCase()) throw new Error('Run belongs to a different repository');
  if (state.status === 'completed') throw new Error('Run already completed');
  if (state.status === 'blocked') throw new Error('Blocked run requires human investigation');
  if (!/^run-[a-zA-Z0-9_-]+$/.test(state.runId)) throw new Error('Invalid run ID');
  const worktree = join(dirname(root), '.factory-worktrees', state.runId);
  const actual = await realpath(worktree);
  if (resolve(actual).toLowerCase() !== resolve(worktree).toLowerCase()) throw new Error('Unexpected worktree location');
  const branch = await git(actual, 'symbolic-ref', '--short', 'HEAD');
  if (branch !== `factory/${state.runId}`) throw new Error(`Unexpected factory branch: ${branch}`);
  const listed = await git(root, 'worktree', 'list', '--porcelain');
  if (!listed.split(/\r?\n/).some(line => line.startsWith('worktree ') && resolve(line.slice(9)).toLowerCase() === resolve(actual).toLowerCase())) throw new Error('Worktree is not registered');
  const dirty = await git(actual, 'status', '--porcelain', '--untracked-files=all');
  if (dirty) throw new Error('Worktree has uncommitted changes; inspect them before resuming');
  const head = await git(actual, 'rev-parse', 'HEAD');
  const completed = Object.values(state.tasks).filter(task => task.status === 'completed');
  for (const task of completed) {
    if (!task.checkpointCommit || !/^[0-9a-f]{40}$/.test(task.checkpointCommit)) throw new Error(`Missing checkpoint for ${task.id}`);
    await git(actual, 'cat-file', '-e', `${task.checkpointCommit}^{commit}`);
    await git(actual, 'merge-base', '--is-ancestor', task.checkpointCommit, head);
  }
  const latest = completed.at(-1)?.checkpointCommit;
  if (latest && head !== latest) throw new Error('HEAD differs from last completed task checkpoint');
  if (!latest) {
    const sourceHead = await git(root, 'rev-parse', 'HEAD');
    if (head !== sourceHead) throw new Error('HEAD differs from initial baseline; manual inspection required');
  }
  for (const task of Object.values(state.tasks)) {
    if (task.status === 'running' || task.status === 'needs_review' || task.status === 'repair_pending' || task.status === 'blocked') {
      throw new Error(`Task ${task.id} is ${task.status}; manual recovery required`);
    }
    if (task.status === 'pending' && task.attempts.length) throw new Error(`Task ${task.id} has unfinished attempt history`);
  }
  return {worktree: actual, head};
}
