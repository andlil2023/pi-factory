import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertCheckoutCheckpoint } from './run-recovery.ts';
import { consumedAttempts, type FactoryRunState, type GitExecutionState } from './state-store.ts';

const exec = promisify(execFile);

export type AutoReplanReason = 'task_too_large' | 'budget_exhausted';

/**
 * The one stopped task that the factory may replan without an operator, if any.
 * Only two causes qualify: the implementer reported the task too large, or the repair budget is spent.
 * Decisions, a missing environment, reviewer blocks, interruptions and agent errors always stop for the operator.
 */
export function autoReplanCandidate(state: FactoryRunState, maxAttempts: number, maxAutoReplans: number): { taskId: string; reason: AutoReplanReason } | undefined {
  if (state.status !== 'blocked' || (state.autoReplans?.length ?? 0) >= maxAutoReplans) return undefined;
  const stopped = Object.values(state.tasks).filter(task => task.status !== 'completed' && task.status !== 'pending');
  if (stopped.length !== 1 || stopped[0].status !== 'blocked') return undefined;
  const task = stopped[0];
  const last = task.attempts.at(-1);
  if (!last) return undefined;
  if (last.outcome === 'blocked') {
    const blockers = (last.implementationReport as { blockers?: Array<{ kind?: unknown }> } | undefined)?.blockers;
    return Array.isArray(blockers) && blockers.length > 0 && blockers.every(blocker => blocker?.kind === 'task_too_large')
      ? { taskId: task.id, reason: 'task_too_large' } : undefined;
  }
  // Rejected work only: the last attempt finished and was refused by verification, UI evidence or review.
  if ((last.outcome === 'implemented' || last.outcome === 'failed') && consumedAttempts(task) >= maxAttempts && task.lastError?.startsWith('Maximum attempts')) {
    return { taskId: task.id, reason: 'budget_exhausted' };
  }
  return undefined;
}

/**
 * Save the uncommitted edits of a superseded task as a patch, then reset the run worktree to its checkpoint.
 * Destructive, so it is confined to the factory-owned run worktree on its expected branch and commit;
 * ignored files (installed dependencies) are kept. Returns the patch path, or undefined when the worktree was clean.
 */
export async function stashLeftover(repository: string, git: GitExecutionState, directory: string, name: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid leftover name');
  const worktree = await realpath(git.worktree);
  if (worktree === await realpath(repository)) throw new Error('Refusing to reset the source repository checkout');
  if (!git.runBranch.startsWith('factory/')) throw new Error('Refusing to reset a branch the factory does not own');
  if (!await assertCheckoutCheckpoint(worktree, git.runBranch, git.expectedHead, true)) return undefined;
  const run = (args: string[]) => exec('git', args, { cwd: worktree, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  // Staging everything makes untracked files part of the patch.
  await run(['add', '-A']);
  const { stdout } = await run(['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD']);
  await mkdir(directory, { recursive: true });
  const patch = join(directory, `${name}.patch`);
  await writeFile(patch, stdout, { flag: 'wx' });
  await run(['reset', '--hard', 'HEAD']);
  await run(['clean', '-fd']);
  if (await assertCheckoutCheckpoint(worktree, git.runBranch, git.expectedHead, true)) throw new Error('Run worktree is still dirty after reset');
  return patch;
}
