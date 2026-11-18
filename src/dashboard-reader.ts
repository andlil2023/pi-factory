import { open, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { consumedAttempts, type FactoryRunState, type TaskState } from './state-store.ts';

const MAX_STATE_BYTES = 5 * 1024 * 1024;
const EVENT_LIMIT = 2000;
const runIdPattern = /^[a-zA-Z0-9_-]+$/;
const runStatuses = ['planned', 'running', 'paused', 'completed', 'blocked'];
const taskStatuses = ['pending', 'running', 'needs_review', 'repair_pending', 'completed', 'blocked'];
const outcomes = ['implemented', 'failed', 'blocked', 'interrupted', 'error'];
const eventTypes = new Set(['RUN_STARTED', 'RUN_COMPLETED', 'RUN_BLOCKED', 'TASK_STARTED', 'TASK_COMPLETED', 'TASK_BLOCKED', 'AGENT_STARTED', 'AGENT_COMPLETED', 'AGENT_FAILED', 'VERIFICATION_STARTED', 'VERIFICATION_PASSED', 'VERIFICATION_FAILED', 'REVIEW_APPROVED', 'REVIEW_CHANGES_REQUESTED', 'REVIEW_BLOCKED', 'REPAIR_STARTED', 'CHECKPOINT_CREATED', 'FINAL_VERIFICATION_PASSED', 'FINAL_VERIFICATION_FAILED', 'PLAN_REVISED']);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function assertId(id: string): void {
  if (!runIdPattern.test(id)) throw new Error('Invalid run ID');
}
function validTask(value: unknown): value is TaskState {
  if (!object(value) || typeof value.id !== 'string' || typeof value.status !== 'string' || !taskStatuses.includes(value.status) || !Array.isArray(value.attempts) || (value.lastError !== undefined && typeof value.lastError !== 'string')) return false;
  return value.attempts.every((a: unknown) => object(a) && Number.isSafeInteger(a.number) && typeof a.startedAt === 'string' && (a.finishedAt === undefined || typeof a.finishedAt === 'string') && (a.outcome === undefined || (typeof a.outcome === 'string' && outcomes.includes(a.outcome))) && (a.reviews === undefined || (Array.isArray(a.reviews) && a.reviews.every((r: unknown) => object(r) && typeof r.reviewer === 'string' && typeof r.verdict === 'string' && ['approved', 'changes_requested', 'blocked'].includes(r.verdict)))));
}
function validState(value: unknown, id: string): value is FactoryRunState {
  if (!object(value) || value.version !== 1 || value.runId !== id || typeof value.repository !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || typeof value.status !== 'string' || !runStatuses.includes(value.status) || !object(value.tasks)) return false;
  if (!Object.entries(value.tasks).every(([key, task]) => validTask(task) && task.id === key)) return false;
  return value.supersededTasks === undefined || (Array.isArray(value.supersededTasks) && value.supersededTasks.every((entry: unknown) => object(entry) && typeof entry.supersededAt === 'string' && validTask(entry.task)));
}
function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (!object(value)) return {};
  return Object.fromEntries(names.filter(name => typeof value[name] === 'string' || (name === 'line' && Number.isSafeInteger(value[name]))).map(name => [name, value[name]]));
}
function displayString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? trimmed.slice(0, limit - 1) + '…' : trimmed;
}
function projectProgress(value: unknown) {
  if (!object(value) || !['full', 'selected'].includes(String(value.mode)) || ![value.completed, value.total, value.failed].every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return undefined;
  return { mode: value.mode, completed: value.completed, total: value.total, failed: value.failed };
}
function projectFinalProgress(value: unknown) {
  const progress = projectProgress(value);
  if (!progress || !object(value)) return undefined;
  const status = typeof value.status === 'string' && ['running', 'passed', 'failed', 'interrupted'].includes(value.status) ? value.status : undefined;
  const currentCheck = Number.isSafeInteger(value.currentCheck) && (value.currentCheck as number) > 0 ? value.currentCheck : undefined;
  const checks = Array.isArray(value.checks) ? value.checks.flatMap((check: unknown) =>
    object(check) && Number.isSafeInteger(check.ordinal) && (check.ordinal as number) > 0 && typeof check.passed === 'boolean'
      ? [{ ordinal: check.ordinal, passed: check.passed }] : []) : undefined;
  const start = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : NaN;
  return { ...progress, status, currentCheck, checks, ...(Number.isFinite(start) ? { startedAt: new Date(start).toISOString() } : {}) };
}
function projectRevisions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((revision: unknown) => {
    if (!object(revision) || typeof revision.at !== 'string' || typeof revision.taskId !== 'string' ||
        (revision.reason !== 'task_too_large' && revision.reason !== 'budget_exhausted') ||
        !Array.isArray(revision.superseded) || !Array.isArray(revision.added)) return [];
    return [{ at: revision.at, taskId: revision.taskId, reason: revision.reason,
      superseded: revision.superseded.filter((id: unknown): id is string => typeof id === 'string'),
      added: revision.added.filter((id: unknown): id is string => typeof id === 'string'),
      hasLeftoverPatch: typeof revision.leftoverPatch === 'string' && revision.leftoverPatch.length > 0 }];
  });
}
function projectTask(task: TaskState, title?: string) {
  return {
    id: task.id, title: title ?? task.id, status: task.status, budgetUsed: consumedAttempts(task), lastError: task.lastError,
    attempts: task.attempts.map(a => ({
      number: a.number, startedAt: a.startedAt, finishedAt: a.finishedAt, outcome: a.outcome,
      phase: typeof a.phase === 'string' ? a.phase : undefined, verificationProgress: projectProgress(a.verificationProgress),
      verification: object(a.verification) && typeof a.verification.passed === 'boolean' ? { passed: a.verification.passed } : undefined,
      flakyCount: object(a.verification) && object(a.verification.details) && Array.isArray(a.verification.details.flaky) ? a.verification.details.flaky.filter((item: unknown) => typeof item === 'string').length : 0,
      blockers: object(a.implementationReport) && Array.isArray(a.implementationReport.blockers) ? a.implementationReport.blockers.map((b: unknown) => {
        const projected = fields(b, ['kind', 'description', 'question']);
        if (object(b) && Array.isArray(b.proposedSplit)) projected.proposedSplit = b.proposedSplit.filter((x: unknown) => typeof x === 'string');
        return projected;
      }) : [],
      reviews: (a.reviews ?? []).map(r => ({ reviewer: r.reviewer, verdict: r.verdict,
        findings: object(r.report) && Array.isArray(r.report.findings) ? r.report.findings.map((f: unknown) => fields(f, ['severity', 'file', 'line', 'description', 'evidence', 'requiredAction'])) : [] }))
    }))
  };
}
/** Explicit allowlist: never return plan, configuration, reports, command output or UI artifacts. */
export function projectRun(state: FactoryRunState) {
  const plan: unknown = state.plan;
  const objective = object(plan) && typeof plan.objective === 'string' ? plan.objective : undefined;
  const label = objective?.split(/\r\n|\r|\n/).map(line => line.trim()).find(Boolean);
  const titles = new Map<string, string>();
  if (object(plan) && Array.isArray(plan.tasks)) {
    for (const task of plan.tasks) {
      if (!object(task) || typeof task.id !== 'string') continue;
      const title = displayString(task.title, 200);
      if (title && !titles.has(task.id)) titles.set(task.id, title);
    }
  }
  const integrations = (Array.isArray(state.integrations) ? state.integrations : []).filter(object);
  const latestIntegration = integrations.at(-1);
  return {
    runId: state.runId, label: displayString(label, 100) ?? state.runId, objectiveSummary: displayString(objective, 2000), createdAt: state.createdAt, updatedAt: state.updatedAt, status: state.status,
    deliveryStatus: latestIntegration?.status === 'published' ? 'integrated'
      : latestIntegration?.status === 'pr-opened' ? 'pr_opened'
      : latestIntegration?.status === 'blocked' && state.status === 'running' ? 'running'
      : typeof latestIntegration?.status === 'string' ? 'integration_' + latestIntegration.status
      : state.status === 'completed' ? 'awaiting_integration' : state.status,
    maxAttempts: Number.isSafeInteger(state.execution?.maxAttempts) ? state.execution?.maxAttempts : undefined,
    autoReplans: projectRevisions(state.autoReplans),
    tasks: Object.values(state.tasks).map(task => projectTask(task, titles.get(task.id))),
    supersededTasks: (state.supersededTasks ?? []).map(entry => ({ supersededAt: entry.supersededAt, task: projectTask(entry.task) })),
    finalVerificationProgress: projectFinalProgress(state.finalVerificationProgress),
    finalVerification: state.finalVerification && typeof state.finalVerification.passed === 'boolean' ? { passed: state.finalVerification.passed, checkedAt: typeof state.finalVerification.checkedAt === 'string' ? state.finalVerification.checkedAt : undefined } : undefined,
    integrations: integrations.map(i => ({
      number: Number.isSafeInteger(i.number) ? i.number : undefined, status: typeof i.status === 'string' ? i.status : undefined, error: typeof i.error === 'string' ? i.error : undefined,
      phase: typeof i.phase === 'string' ? i.phase : undefined,
      failedPhase: typeof i.failedPhase === 'string' && ['creating_worktree', 'merging', 'setup', 'verifying', 'selecting_reviewers', 'collecting_ui_evidence', 'reviewing', 'checking_candidate', 'awaiting_publication', 'publication_checking', 'publication_verifying', 'publishing'].includes(i.failedPhase) ? i.failedPhase : undefined,
      phaseUpdatedAt: typeof i.phaseUpdatedAt === 'string' ? i.phaseUpdatedAt : undefined,
      verificationProgress: projectProgress(i.verificationProgress),
      requiredReviewers: object(i.reviewSelection) && Array.isArray(i.reviewSelection.requiredReviewers) ? i.reviewSelection.requiredReviewers.filter(id => typeof id === 'string') : [],
      verification: object(i.verification) && typeof i.verification.passed === 'boolean' ? { passed: i.verification.passed } : undefined,
      publicationVerification: object(i.publicationVerification) && typeof i.publicationVerification.passed === 'boolean' ? { passed: i.publicationVerification.passed } : undefined,
      uiEvidence: object(i.uiEvidence) && typeof i.uiEvidence.passed === 'boolean' ? { passed: i.uiEvidence.passed } : undefined,
      reviews: Array.isArray(i.reviews) ? i.reviews.filter(object).map(r => ({ reviewer: typeof r.reviewer === 'string' ? r.reviewer : undefined, verdict: typeof r.verdict === 'string' ? r.verdict : undefined, findings: object(r.report) && Array.isArray(r.report.findings) ? r.report.findings.map((f: unknown) => fields(f, ['severity', 'file', 'line', 'description', 'evidence', 'requiredAction'])) : [] })) : []
    }))
  };
}
export type ProjectedRun = ReturnType<typeof projectRun>;
export type RunRead = { runId: string; available: true; run: ProjectedRun } | { runId: string; available: false };

export class DashboardReader {
  readonly directory: string;
  constructor(repository: string) { this.directory = join(resolve(repository), '.factory', 'runs'); }
  async readRun(runId: string): Promise<RunRead> {
    assertId(runId);
    try {
      const handle = await open(join(this.directory, `${runId}.json`), 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return { runId, available: false };
        // Bounded read also handles a file growing after stat.
        const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > MAX_STATE_BYTES) return { runId, available: false };
        const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
        if (!validState(value, runId)) return { runId, available: false };
        return { runId, available: true, run: projectRun(value) };
      } finally { await handle.close(); }
    } catch { return { runId, available: false }; }
  }
  async listRuns(): Promise<RunRead[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ids = names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(id => runIdPattern.test(id)).sort();
    return Promise.all(ids.map(id => this.readRun(id)));
  }
  async readEvents(runId: string) {
    assertId(runId);
    let text: string;
    try { text = await readFile(join(this.directory, `${runId}.events.jsonl`), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split('\n')) {
      try {
        const event: unknown = JSON.parse(line);
        if (!object(event) || event.runId !== runId || typeof event.timestamp !== 'string' || typeof event.type !== 'string' || !eventTypes.has(event.type)) continue;
        const projected = fields(event, ['timestamp', 'runId', 'type', 'taskId', 'agent', 'message']);
        if (Number.isSafeInteger(event.attempt)) projected.attempt = event.attempt;
        events.push(projected);
        if (events.length > EVENT_LIMIT) events.shift();
      } catch { /* incomplete or corrupt log line */ }
    }
    return events;
  }
}
