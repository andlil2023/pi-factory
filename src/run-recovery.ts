import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeInfo } from './git-worktree.ts';
import { consumedAttempts, type FactoryRunState, type GitExecutionState, type StateStore } from './state-store.ts';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Identifies the configuration a run was started with. Time limits (`timeoutMs`) are excluded:
 * they bound how long a step may take, not what it does, so an operator may change them between resumes.
 * The integration repair budget and specification workflow settings are also excluded for existing runs.
 * `includeTimeouts` reproduces the fingerprint of runs started before the timeout exclusion.
 */
export function configurationFingerprint(config: unknown, includeTimeouts = false): string {
  const normalize = (value: unknown, path: string[]): unknown => {
    if (Array.isArray(value)) return value.map(child => normalize(child, [...path, '[]']));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !(path.length === 0 && key === 'specifications') && !(path.length === 1 && path[0] === 'agents' && (key === 'impactAnalyst' || key === 'specReviewer')) && !(path.length === 1 && path[0] === 'execution' && key === 'maxIntegrationRepairs') && (includeTimeouts || key !== 'timeoutMs')).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child, [...path, key])]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify(normalize(config, []))).digest('hex');
}

/** The fingerprint to compare with a persisted run: the older, timeout-sensitive form when that is what the run recorded. */
export function fingerprintForRun(config: unknown, recorded: string | undefined): string {
  const legacy = configurationFingerprint(config, true);
  return recorded === legacy ? legacy : configurationFingerprint(config);
}

export async function captureRunGitState(info: WorktreeInfo): Promise<GitExecutionState> {
  const targetRef = await git(info.repository, ['symbolic-ref', '--quiet', 'HEAD']);
  if (!targetRef.startsWith('refs/heads/')) throw new Error('Run requires a named target branch');
  if (await git(info.repository, ['rev-parse', 'HEAD']) !== info.baseCommit) throw new Error('Target moved while creating the run');
  return { worktree: await realpath(info.path), runBranch: info.branch, targetBranch: targetRef.slice(11), baseCommit: info.baseCommit, expectedHead: info.baseCommit };
}

/** Validate the task boundary without modifying Git or rewalking checkpoint history. */
export async function assertRunCheckpoint(state: FactoryRunState, allowDirty = false): Promise<boolean> {
  const saved = state.git;
  if (!saved) throw new Error('Missing persisted Git metadata');
  return assertCheckoutCheckpoint(saved.worktree, saved.runBranch, saved.expectedHead, allowDirty);
}

export async function assertCheckoutCheckpoint(worktree: string, branch: string, head: string, allowDirty = false): Promise<boolean> {
  if (await git(worktree, ['symbolic-ref', '--quiet', 'HEAD']) !== `refs/heads/${branch}`) throw new Error('Git worktree is on the wrong branch');
  if (await git(worktree, ['rev-parse', 'HEAD']) !== head) throw new Error('HEAD differs from the expected checkpoint; inspect before continuing');
  const gitDirectory = await git(worktree, ['rev-parse', '--absolute-git-dir']);
  for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const path = resolve(gitDirectory, operation);
    try { await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Unfinished Git operation: ${operation}`);
  }
  if (await git(worktree, ['ls-files', '--unmerged', '-z'])) throw new Error('Run worktree has unresolved conflicts');
  const dirty = !!await git(worktree, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty && !allowDirty) throw new Error('Run worktree is dirty; inspect it and explicitly authorize the active task retry');
  return dirty;
}

/** Read-only preflight. No reset, checkout, merge, branch changes, or cleanup. */
export async function validateRunGitState(state: FactoryRunState, repository: string, allowDirty = false): Promise<{ dirty: boolean; targetHead: string }> {
  const saved = state.git;
  if (!saved || !state.execution) throw new Error('Run lacks persisted Git/execution metadata; automatic resume is unavailable for legacy runs');
  for (const key of ['worktree', 'runBranch', 'targetBranch', 'baseCommit', 'expectedHead'] as const) {
    if (typeof saved[key] !== 'string' || !saved[key]) throw new Error('Invalid persisted Git metadata');
  }
  if (saved.runBranch !== `factory/${state.runId}` || !/^[a-f0-9]{40,64}$/.test(saved.baseCommit) || !/^[a-f0-9]{40,64}$/.test(saved.expectedHead)) throw new Error('Invalid persisted branch/checkpoint metadata');
  const repo = await realpath(repository);
  if (repo !== await realpath(state.repository) || repo !== await realpath(await git(repo, ['rev-parse', '--show-toplevel']))) throw new Error('Run repository mismatch');
  const worktree = await realpath(saved.worktree);
  if (worktree === repo || worktree !== await realpath(await git(worktree, ['rev-parse', '--show-toplevel']))) throw new Error('Invalid run worktree root');
  const common = async (cwd: string) => realpath(resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'])));
  if (await common(repo) !== await common(worktree)) throw new Error('Run worktree belongs to another repository');
  const listing = await git(repo, ['worktree', 'list', '--porcelain', '-z']);
  let registered = false;
  for (const entry of listing.split('\0\0')) {
    const fields = entry.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9);
    if (!path || !fields.includes(`branch refs/heads/${saved.runBranch}`)) continue;
    if (await realpath(path) === worktree) registered = true;
  }
  if (!registered) throw new Error('Expected run worktree/branch is not registered');
  const dirty = await assertRunCheckpoint(state, allowDirty);
  // Every accepted checkpoint must be represented exactly once in the linear run history.
  const checkpoints = new Set<string>();
  for (const task of Object.values(state.tasks)) {
    if (task.status !== 'completed') {
      if (task.checkpointCommit) throw new Error('Incomplete task has an accepted checkpoint; inspect state');
      continue;
    }
    if (!task.checkpointCommit || checkpoints.has(task.checkpointCommit) || !task.attempts.some(attempt => attempt.checkpointCommit === task.checkpointCommit)) throw new Error('Completed task checkpoint metadata is inconsistent');
    checkpoints.add(task.checkpointCommit);
  }
  let cursor = saved.expectedHead;
  while (cursor !== saved.baseCommit) {
    if (!checkpoints.delete(cursor)) throw new Error('Unrecorded commit in run history');
    const parents = (await git(worktree, ['rev-list', '--parents', '-n', '1', cursor])).split(' ');
    if (parents.length !== 2) throw new Error('Run checkpoint history must be linear');
    cursor = parents[1];
  }
  if (checkpoints.size) throw new Error('Checkpoint is not part of the run history');
  await git(repo, ['check-ref-format', `refs/heads/${saved.targetBranch}`]);
  const targetHead = await git(repo, ['rev-parse', '--verify', `refs/heads/${saved.targetBranch}^{commit}`]);
  await git(repo, ['merge-base', '--is-ancestor', saved.baseCommit, targetHead]);
  return { dirty, targetHead };
}

export const MAX_GUIDANCE_LENGTH = 20_000;

/** Caller holds an exclusive run lock and has validated the persisted plan. */
export async function prepareRunResume(store: StateStore, state: FactoryRunState, repository: string, fingerprint: string, maxAttempts: number, retryTask?: string, guidance?: string, maxInfraRetries = 0): Promise<FactoryRunState> {
  if (!state.execution || !Number.isSafeInteger(state.execution.maxAttempts) || state.execution.maxAttempts < 1 || !Number.isSafeInteger(state.execution.maxInfraRetries ?? 0) || (state.execution.maxInfraRetries ?? 0) < 0 || !Number.isSafeInteger(maxInfraRetries) || maxInfraRetries < 0 || (state.execution.maxInfraRetries ?? 0) !== maxInfraRetries || state.execution.configurationFingerprint !== fingerprint || state.execution.maxAttempts !== maxAttempts) throw new Error('Resume requires the original execution configuration and retry budget');
  if (state.status === 'completed') throw new Error('Run is already completed; integration is a separate operation');
  const active = Object.values(state.tasks).filter(task => task.status !== 'pending' && task.status !== 'completed');
  if (active.length > 1) throw new Error('Multiple unfinished active tasks; inspect state before resuming');
  if (active.length && active[0].id !== retryTask) throw new Error(`Inspect the failed/interrupted task and explicitly pass --retry-task ${active[0].id}`);
  if (retryTask && (active.length !== 1 || active[0].id !== retryTask)) throw new Error('--retry-task must identify the existing failed/interrupted task');
  for (const task of Object.values(state.tasks)) {
    if (task.attempts.some((attempt, index) => attempt.number !== index + 1) || consumedAttempts(task) > maxAttempts || (task.status === 'pending' && task.attempts.length)) throw new Error('Invalid attempt history');
  }
  if (guidance !== undefined && (!retryTask || !guidance.trim() || guidance.length > MAX_GUIDANCE_LENGTH)) throw new Error(`Guidance requires --retry-task and 1-${MAX_GUIDANCE_LENGTH} characters`);
  if (active.length && consumedAttempts(active[0]) >= maxAttempts) throw new Error('Retry budget exhausted; resume cannot reset or increase it');
  await validateRunGitState(state, repository, !!retryTask);
  const previousStatus = state.status;
  const recovered = await store.recover(state.runId);
  if (retryTask) recovered.tasks[retryTask].status = 'repair_pending';
  recovered.status = 'paused';
  recovered.resumptions ??= [];
  recovered.resumptions.push({ approvedAt: new Date().toISOString(), previousStatus, ...(retryTask ? { retryTask } : {}), ...(guidance !== undefined ? { guidance } : {}) });
  // A previous failed final verification is historical evidence, not current success.
  await store.save(recovered);
  return recovered;
}
