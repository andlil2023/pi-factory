import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReviewSelection } from './review-routing.ts';
import type { UiEvidenceRecord } from './ui-evidence.ts';

export type TaskStatus = 'pending' | 'running' | 'needs_review' | 'repair_pending' | 'completed' | 'blocked';
/** `error` is an agent/infrastructure failure, as opposed to work the implementer reported as `failed`. */
export type AttemptOutcome = 'implemented' | 'failed' | 'blocked' | 'interrupted' | 'error';
export type ReviewVerdict = 'approved' | 'changes_requested' | 'blocked';

export interface AttemptRecord {
  number: number;
  startedAt: string;
  finishedAt?: string;
  outcome?: AttemptOutcome;
  implementationReport?: unknown;
  verification?: unknown;
  uiEvidence?: UiEvidenceRecord;
  reviewSelection?: ReviewSelection;
  reviews?: Array<{ reviewer: string; verdict: ReviewVerdict; report: unknown }>;
  checkpointCommit?: string;
  /** An automatic retry was allocated after this failed invocation. */
  infraRetry?: { role: 'implementer' | 'reviewer'; error: string };
}

export interface TaskState {
  id: string;
  status: TaskStatus;
  attempts: AttemptRecord[];
  reviewSelection?: ReviewSelection;
  lastError?: string;
  checkpointCommit?: string;
}

export interface GitExecutionState {
  worktree: string;
  runBranch: string;
  targetBranch: string;
  baseCommit: string;
  expectedHead: string;
}
export interface ExecutionPolicy {
  maxAttempts: number;
  maxInfraRetries?: number;
  configurationFingerprint: string;
}

export interface IntegrationAttempt {
  number: number;
  status: 'preparing' | 'conflicted' | 'blocked' | 'ready' | 'stale' | 'publishing' | 'published' | 'pr-publishing' | 'pr-opened';
  approvedAt: string;
  worktree: string;
  branch: string;
  targetBranch: string;
  targetHead: string;
  sourceHead: string;
  commit?: string;
  conflicts?: string[];
  error?: string;
  verification?: { passed: boolean; details: unknown };
  publicationVerification?: { passed: boolean; details: unknown };
  reviewSelection?: ReviewSelection;
  reviews?: AttemptRecord['reviews'];
  uiEvidence?: UiEvidenceRecord;
  publishApprovedAt?: string;
  publishedAt?: string;
  pullRequest?: { repository: string; remote: string; pushUrl: string; base: string; baseSha: string; head: string; headSha: string; url?: string };
}

export interface FactoryRunState {
  version: 1;
  runId: string;
  repository: string;
  createdAt: string;
  updatedAt: string;
  status: 'planned' | 'running' | 'paused' | 'completed' | 'blocked';
  plan: unknown;
  git?: GitExecutionState;
  execution?: ExecutionPolicy;
  integrations?: IntegrationAttempt[];
  /** `guidance` is the operator's answer to the retried task's blockers. */
  resumptions?: Array<{ approvedAt: string; previousStatus: FactoryRunState['status']; retryTask?: string; guidance?: string }>;
  /** Plans replaced by an approved amendment, oldest first. */
  planRevisions?: Array<{ replacedAt: string; plan: unknown }>;
  /** Tasks removed by an amendment; their attempt history is evidence. */
  supersededTasks?: Array<{ supersededAt: string; task: TaskState }>;
  finalVerification?: { passed: boolean; details: unknown; checkedAt: string; head?: string };
  tasks: Record<string, TaskState>;
}

/**
 * Attempts that count against the repair budget: finished work that was or could be rejected.
 * Blocked reports, interruptions and errors always stop for the operator, so each
 * further attempt already needs an approved resume.
 */
export function consumedInfraRetries(task: TaskState): number {
  return task.attempts.filter(attempt => attempt.infraRetry !== undefined).length;
}

export function consumedAttempts(task: TaskState): number {
  return task.attempts.filter(attempt => attempt.finishedAt !== undefined
    && attempt.outcome !== 'blocked' && attempt.outcome !== 'interrupted' && attempt.outcome !== 'error').length;
}

function assertRunId(runId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run ID');
}

function validateState(value: unknown, expectedRunId: string): asserts value is FactoryRunState {
  if (!value || typeof value !== 'object') throw new Error('Invalid run state');
  const state = value as Partial<FactoryRunState>;
  if (state.version !== 1 || state.runId !== expectedRunId || !state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks)) {
    throw new Error('Invalid or unsupported run state');
  }
}

export class StateStore {
  readonly directory: string;
  private readonly renameSnapshot: typeof rename;

  constructor(repository: string, renameSnapshot: typeof rename = rename) {
    this.renameSnapshot = renameSnapshot;
    this.directory = join(resolve(repository), '.factory', 'runs');
  }

  private path(runId: string): string {
    assertRunId(runId);
    return join(this.directory, `${runId}.json`);
  }

  async create(repository: string, plan: unknown, taskIds: string[], runId: string = randomUUID(), metadata: { git?: GitExecutionState; execution?: ExecutionPolicy } = {}): Promise<FactoryRunState> {
    assertRunId(runId);
    if (new Set(taskIds).size !== taskIds.length || taskIds.length === 0) throw new Error('Task IDs must be unique and nonempty');
    const now = new Date().toISOString();
    const tasks: Record<string, TaskState> = Object.fromEntries(taskIds.map((id): [string, TaskState] => [id, { id, status: 'pending', attempts: [] }]));
    const state: FactoryRunState = {
      version: 1, runId, repository: resolve(repository), createdAt: now, updatedAt: now,
      status: 'planned', plan, tasks, ...metadata
    };
    await mkdir(this.directory, { recursive: true });
    const handle = await open(this.path(runId), 'wx');
    try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); }
    finally { await handle.close(); }
    return state;
  }

  async load(runId: string): Promise<FactoryRunState> {
    const value: unknown = JSON.parse(await readFile(this.path(runId), 'utf8'));
    validateState(value, runId);
    return value;
  }

  /** Persist a full state snapshot. Caller must serialize updates per run. */
  async save(state: FactoryRunState): Promise<void> {
    validateState(state, state.runId);
    const path = this.path(state.runId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const updated = { ...state, updatedAt: new Date().toISOString() };
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx' });
      for (let attempt = 1; ; attempt++) {
        try {
          await this.renameSnapshot(temporary, path);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
          await new Promise(resolve => setTimeout(resolve, attempt * 25));
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    state.updatedAt = updated.updatedAt;
  }

  /** Caller must hold the run lock. Mark incomplete work interrupted; never silently retry. */
  async recover(runId: string): Promise<FactoryRunState> {
    const state = await this.load(runId);
    let changed = false;
    for (const task of Object.values(state.tasks)) {
      if (task.status !== 'running' && task.status !== 'needs_review') continue;
      const attempt = task.attempts.at(-1);
      if (attempt && !attempt.finishedAt) {
        attempt.finishedAt = new Date().toISOString();
        attempt.outcome = 'interrupted';
      }
      task.status = 'blocked';
      task.lastError = 'Execution interrupted; inspect working tree before resuming';
      changed = true;
    }
    if (changed) {
      state.status = 'paused';
      await this.save(state);
    }
    return state;
  }
}
