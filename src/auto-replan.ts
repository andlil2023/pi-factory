import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import type { PlannedTask } from './orchestrator.ts';
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
  // A final-verification repair has its own budget; replanning it would only add time.
  if (state.finalRepairs?.some(repair => repair.taskId === task.id)) return undefined;
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
 * Deterministic limits on a plan revision that no operator will read before it runs.
 * The revision may only replace the stopped task: it cannot drop or rewrite other work,
 * and every acceptance criterion of the stopped task must survive verbatim in a replacement.
 */
export function assertReplacementPlan(current: { objective?: unknown; tasks: PlannedTask[] }, revised: { objective?: unknown; tasks: PlannedTask[] }, taskId: string): void {
  if (!isDeepStrictEqual(current.objective, revised.objective)) throw new Error('the revision changes the objective');
  const stopped = current.tasks.find(task => task.id === taskId);
  if (!stopped) throw new Error(`${taskId} is not in the current plan`);
  const next = new Map(revised.tasks.map(task => [task.id, task]));
  if (next.has(taskId)) throw new Error(`the planner kept ${taskId}`);
  for (const task of current.tasks) {
    if (task.id === taskId) continue;
    const kept = next.get(task.id);
    if (!kept) throw new Error(`the revision removes ${task.id}`);
    // Dependents of the stopped task must be re-pointed; nothing else about another task may change.
    if (!isDeepStrictEqual({ ...kept, dependencies: [] }, { ...task, dependencies: [] })) throw new Error(`the revision changes ${task.id}`);
  }
  const known = new Set(current.tasks.map(task => task.id));
  const added = revised.tasks.filter(task => !known.has(task.id));
  if (!added.length) throw new Error(`the revision adds no replacement for ${taskId}`);
  const carried = new Set(added.flatMap(task => task.acceptanceCriteria));
  const dropped = stopped.acceptanceCriteria.filter(criterion => !carried.has(criterion));
  if (dropped.length) throw new Error(`the replacement tasks drop or reword ${dropped.length} acceptance criterion/criteria of ${taskId}`);
}

async function ownedWorktree(repository: string, git: GitExecutionState): Promise<{ worktree: string; dirty: boolean }> {
  const worktree = await realpath(git.worktree);
  if (worktree === await realpath(repository)) throw new Error('Refusing to reset the source repository checkout');
  if (!git.runBranch.startsWith('factory/')) throw new Error('Refusing to reset a branch the factory does not own');
  return { worktree, dirty: await assertCheckoutCheckpoint(worktree, git.runBranch, git.expectedHead, true) };
}
const gitIn = (worktree: string, args: string[]) => exec('git', args, { cwd: worktree, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

/**
 * Save the uncommitted edits of the run worktree, tracked and untracked, as a binary-safe patch.
 * Changes no file content. Returns the patch path, or undefined when the worktree is clean.
 */
export async function saveLeftoverPatch(repository: string, git: GitExecutionState, directory: string, name: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid leftover name');
  const { worktree, dirty } = await ownedWorktree(repository, git);
  if (!dirty) return undefined;
  await mkdir(directory, { recursive: true });
  const patch = join(directory, `${name}.patch`);
  let exists = true;
  try { await stat(patch); } catch { exists = false; }
  if (exists) throw new Error('Leftover patch already exists');
  // Staging everything makes untracked files part of the patch. Git writes the file itself: no text decoding of the bytes.
  await gitIn(worktree, ['add', '-A']);
  try { await gitIn(worktree, ['diff', '--cached', '--binary', '--no-ext-diff', `--output=${patch}`, 'HEAD']); }
  finally { await gitIn(worktree, ['reset', '--quiet', 'HEAD']); }
  if ((await stat(patch)).size === 0) throw new Error('Leftover patch is empty although the worktree is dirty');
  return patch;
}

/**
 * Reset the run worktree to its checkpoint. Destructive, so it is confined to the factory-owned run worktree
 * on its expected branch and commit; ignored files (installed dependencies) are kept.
 * Call only after saveLeftoverPatch returned for the same state.
 */
export async function resetRunWorktree(repository: string, git: GitExecutionState): Promise<void> {
  const { worktree, dirty } = await ownedWorktree(repository, git);
  if (!dirty) return;
  await gitIn(worktree, ['reset', '--hard', 'HEAD']);
  await gitIn(worktree, ['clean', '-fd']);
  if (await assertCheckoutCheckpoint(worktree, git.runBranch, git.expectedHead, true)) throw new Error('Run worktree is still dirty after reset');
}

