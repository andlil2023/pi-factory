import type { FactoryEventBus } from './event-bus.ts';
import { AgentExecutionError } from './agent-error.ts';
import { appendReviewResult, reconcileReviewResults } from './review-results.ts';
import type { ReviewSelection } from './review-routing.ts';
import type { UiEvidenceRecord } from './ui-evidence.ts';
import { buildAttemptFeedback, buildFinalFailureFeedback, type AttemptFeedback } from './attempt-feedback.ts';
import { consumedAttempts, consumedInfraRetries, type FactoryRunState, type StateStore, type AttemptRecord, type ReviewVerdict, type VerificationProgress } from './state-store.ts';

export interface PlannedTask {
  id: string;
  title: string;
  objective: string;
  scope: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  verification: string[];
}
/** A reason the implementer cannot proceed. Remaining work is never a blocker. */
export interface Blocker {
  kind: 'decision_needed' | 'environment_missing' | 'task_too_large';
  description: string;
  question?: string;
  proposedSplit?: string[];
}
export interface ImplementationResult {
  outcome: 'implemented' | 'blocked' | 'failed';
  report: unknown;
  blockers?: Blocker[];
}
export interface ReviewResult {
  reviewer: string;
  verdict: ReviewVerdict;
  report: unknown;
}
export type ReviewProgress = (review: ReviewResult) => Promise<void>;
export interface VerificationResult {
  passed: boolean;
  details: unknown;
}
export interface TaskContext {
  task: PlannedTask;
  /** Persisted plan, including assumptions and resolved decisions; background only. */
  plan?: unknown;
  attempt: number;
  previousFeedback: unknown[];
  /** Structured view of the previous attempts of this task; absent on a first attempt. */
  feedback?: AttemptFeedback;
  /** Operator answers recorded on approved retries of this task; authoritative. */
  operatorGuidance?: string[];
  /** Integration-only provenance. Historical checks and operator reports are not current candidate proof. */
  integrationEvidence?: {
    sourceRepository: string;
    sourceWorktree: string;
    taskGuidance: Array<{ taskId: string; approvedAt: string; text: string }>;
    integrationGuidance: Array<{ attempt: number; approvedAt: string; text: string }>;
    taskVerification: Array<{ taskId: string; attempt: number; checkpoint?: string; result: unknown }>;
  };
  onVerificationProgress?(progress: VerificationProgress): Promise<void>;
  /** Include per-check live progress for final verification. */
  finalVerificationProgress?: boolean;
  requiredReviewers?: string[];
  uiEvidence?: UiEvidenceRecord;
  /** Run every trusted verification command, ignoring task-level selection. */
  fullVerification?: boolean;
}
export interface OrchestratorAdapters {
  implement(context: TaskContext): Promise<ImplementationResult>;
  verify(context: TaskContext): Promise<VerificationResult>;
  selectReviewers?(context: TaskContext): Promise<ReviewSelection>;
  collectUiEvidence?(context: TaskContext): Promise<UiEvidenceRecord>;
  review(context: TaskContext, implementation: ImplementationResult, verification: VerificationResult, onReview?: ReviewProgress): Promise<ReviewResult[]>;
  checkpoint?(context: TaskContext): Promise<{ commit: string }>;
  finalVerify?(onProgress: (progress: VerificationProgress) => Promise<void>): Promise<VerificationResult>;
  /** Whether the worktree differs from the last checkpoint. Lets a final repair that changed nothing be withdrawn. */
  hasChanges?(context: TaskContext): Promise<boolean>;
}
export interface OrchestratorOptions {
  maxAttempts?: number;
  requiredReviewers?: string[];
  events?: FactoryEventBus;
  /** Repair tasks the orchestrator may add after a failed final verification. Default 0: block. */
  maxFinalRepairs?: number;
}

/** A task that repairs a failed final verification. It is verified with every trusted command and reviewed like any other task. */
function finalRepairTask(state: FactoryRunState, tasks: PlannedTask[]): PlannedTask {
  const numbers = [...tasks.map(task => task.id), ...Object.keys(state.tasks), ...(state.supersededTasks ?? []).map(entry => entry.task.id)]
    .map(id => Number(/^T(\d+)$/.exec(id)?.[1])).filter(Number.isSafeInteger);
  return {
    id: `T${String(Math.max(0, ...numbers) + 1).padStart(3, '0')}`,
    title: 'Repair final verification failure',
    objective: 'Make the trusted full verification of the completed run pass.',
    scope: 'Fix the cause of the failed checks listed in the feedback. Do not delete, skip or weaken tests, and do not change behavior that earlier tasks were accepted for.',
    acceptanceCriteria: ['Every trusted verification command passes on the combined result of the run', 'No test is deleted, skipped or weakened to make verification pass'],
    dependencies: tasks.map(task => task.id),
    verification: ['Rerun the failing tests named in the feedback']
  };
}

/** Sequential, deterministic orchestration. Agent calls and verification are injected adapters. */
export class Orchestrator {
  private readonly store: StateStore;
  private readonly adapters: OrchestratorAdapters;
  private readonly options: OrchestratorOptions;
  constructor(store: StateStore, adapters: OrchestratorAdapters, options: OrchestratorOptions = {}) {
    this.store = store;
    this.adapters = adapters;
    this.options = options;
  }

  async execute(state: FactoryRunState, tasks: PlannedTask[]): Promise<FactoryRunState> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const maxInfraRetries = state.execution?.maxInfraRetries ?? 0;
    if (!Number.isSafeInteger(maxInfraRetries) || maxInfraRetries < 0) throw new Error('Invalid maxInfraRetries');
    const requiredReviewers = this.options.requiredReviewers ?? ['code'];
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('Invalid maxAttempts');
    if (!requiredReviewers.includes('code') || new Set(requiredReviewers).size !== requiredReviewers.length) throw new Error('Invalid required reviewers');
    const ids = new Set(tasks.map(t => t.id));
    if (ids.size !== tasks.length || ids.size !== Object.keys(state.tasks).length || tasks.some(t => !state.tasks[t.id])) throw new Error('Task plan/state mismatch');
    for (const task of tasks) if (task.dependencies.some(d => !ids.has(d) || d === task.id)) throw new Error(`Invalid dependencies: ${task.id}`);
    if (Object.values(state.tasks).some(t => t.status === 'running' || t.status === 'needs_review')) throw new Error('Interrupted run requires recovery before execution');
    this.options.events?.emit({type:'RUN_STARTED'});
    state.status = 'running';
    await this.store.save(state);
    while (true) {
      const remaining = tasks.filter(t => state.tasks[t.id].status !== 'completed');
      if (!remaining.length) {
        if (this.adapters.finalVerify) {
          const startedAt = new Date().toISOString();
          state.finalVerificationProgress = { mode: 'full', completed: 0, total: 0, failed: 0, status: 'running', checks: [], startedAt };
          delete state.finalVerification;
          await this.store.save(state);
          try {
            const final = await this.adapters.finalVerify(async progress => {
              state.finalVerificationProgress = {
                mode: progress.mode, completed: progress.completed, total: progress.total, failed: progress.failed,
                status: 'running', startedAt, ...(progress.currentCheck === undefined ? {} : { currentCheck: progress.currentCheck }),
                ...(progress.checks ? { checks: progress.checks.map(check => ({ ordinal: check.ordinal, passed: check.passed })) } : {})
              };
              await this.store.save(state);
            });
            state.finalVerification = { ...final, checkedAt: new Date().toISOString() };
            state.finalVerificationProgress.status = final.passed ? 'passed' : 'failed';
            delete state.finalVerificationProgress.currentCheck;
            this.options.events?.emit({type: final.passed ? 'FINAL_VERIFICATION_PASSED' : 'FINAL_VERIFICATION_FAILED'});
            const repairs = state.finalRepairs ?? [];
            if (!final.passed && repairs.length < (this.options.maxFinalRepairs ?? 0)) {
              // The combined result failed although every task was accepted: give it the same repair path as a task failure.
              const now = new Date().toISOString();
              const task = finalRepairTask(state, tasks);
              state.planRevisions = [...(state.planRevisions ?? []), { replacedAt: now, plan: structuredClone(state.plan) }];
              const planned = (state.plan as { tasks?: unknown } | null)?.tasks;
              if (Array.isArray(planned) && planned !== tasks) planned.push(structuredClone(task));
              tasks.push(task);
              ids.add(task.id);
              state.tasks[task.id] = { id: task.id, status: 'pending', attempts: [] };
              state.finalRepairs = [...repairs, { at: now, taskId: task.id, verification: structuredClone(final) }];
              this.options.events?.emit({type:'PLAN_REVISED',taskId:task.id,message:`Final verification failed; added repair task ${task.id} (${repairs.length + 1} of ${this.options.maxFinalRepairs})`});
              await this.store.save(state);
              continue;
            }
            if (!final.passed) {
              state.status = 'blocked';
              this.options.events?.emit({type:'RUN_BLOCKED', message:'Final verification failed'});
              await this.store.save(state);
              return state;
            }
          } catch (error) {
            state.finalVerificationProgress!.status = 'failed';
            delete state.finalVerificationProgress!.currentCheck;
            state.finalVerification = { passed: false, details: String(error), checkedAt: new Date().toISOString() };
            state.status = 'blocked';
            this.options.events?.emit({type:'FINAL_VERIFICATION_FAILED',message:String(error)});
            this.options.events?.emit({type:'RUN_BLOCKED',message:'Final verification error'});
            await this.store.save(state);
            return state;
          }
        }
        state.status = 'completed'; this.options.events?.emit({type:'RUN_COMPLETED'}); await this.store.save(state); return state;
      }
      if (remaining.some(t => state.tasks[t.id].status === 'blocked')) { state.status = 'blocked'; this.options.events?.emit({type:'RUN_BLOCKED'}); await this.store.save(state); return state; }
      const ready = remaining.find(t => state.tasks[t.id].status !== 'blocked' && t.dependencies.every(d => state.tasks[d].status === 'completed'));
      if (!ready) { state.status = 'blocked'; await this.store.save(state); throw new Error('No ready tasks: cyclic dependencies or blocked prerequisites'); }
      const taskState = state.tasks[ready.id];
      let withdrawn = false;
      this.options.events?.emit({type:'TASK_STARTED',taskId:ready.id});
      while (consumedAttempts(taskState) < maxAttempts && taskState.status !== 'completed' && taskState.status !== 'blocked') {
        const attempt: AttemptRecord = { phase: 'implementing', number: taskState.attempts.length + 1, startedAt: new Date().toISOString() };
        taskState.attempts.push(attempt);
        taskState.status = 'running';
        await this.store.save(state);
        const feedback = taskState.attempts.slice(0, -1).flatMap(a => [
          ...(a.outcome === 'blocked' || a.outcome === 'failed' || a.outcome === 'interrupted' || a.outcome === 'error' ? [a.implementationReport] : []),
          ...(a.infraRetry ? [`Factory retry note: ${a.infraRetry.role} failed: ${a.infraRetry.error}. Inspect the worktree and continue any remaining edits; keep work tightly scoped to the task.`] : []),
          a.verification, ...(a.reviews ?? []).map(r => r.report),
          ...(a.uiEvidence && !a.uiEvidence.passed ? [a.uiEvidence] : [])
        ].filter(x => x !== undefined));
        const operatorGuidance = (state.resumptions ?? []).flatMap(r => r.retryTask === ready.id && r.guidance ? [r.guidance] : []);
        const context: TaskContext = { task: ready, plan: structuredClone(state.plan), attempt: attempt.number, previousFeedback: feedback, ...(operatorGuidance.length ? { operatorGuidance } : {}) };
        const structured = buildAttemptFeedback(taskState.attempts.slice(0, -1));
        if (structured) context.feedback = structured;
        const finalRepair = state.finalRepairs?.find(repair => repair.taskId === ready.id);
        if (finalRepair) {
          context.fullVerification = true;
          // Until an attempt of the repair itself produces failed checks or findings, the open items are those of the
          // failed final verification. An attempt that only timed out or crashed must not hide them.
          const own = context.feedback;
          if (!own || (!own.open.failedChecks.length && !own.open.findings.length && !own.open.uiEvidenceIssues.length)) {
            const final = buildFinalFailureFeedback(finalRepair.verification);
            context.feedback = { ...final, notes: [...final.notes, ...(own?.notes ?? [])], history: own?.history ?? [] };
          }
        }
        context.onVerificationProgress = async progress => {
          attempt.verificationProgress = progress;
          await this.store.save(state);
        };
        const phase = async (value: AttemptRecord['phase']) => {
          attempt.phase = value;
          await this.store.save(state);
        };
        if (attempt.number > 1) this.options.events?.emit({type:'REPAIR_STARTED',taskId:ready.id,attempt:attempt.number});
        try {
          this.options.events?.emit({type:'AGENT_STARTED',taskId:ready.id,agent:'implementer',attempt:attempt.number});
          const implementation = await this.adapters.implement(context);
          this.options.events?.emit({type:'AGENT_COMPLETED',taskId:ready.id,agent:'implementer',attempt:attempt.number,message:implementation.outcome});
          attempt.implementationReport = implementation.report;
          attempt.outcome = implementation.outcome === 'implemented' ? 'implemented' : implementation.outcome;
          if (implementation.outcome === 'blocked') {
            taskState.status = 'blocked';
            taskState.lastError = implementation.blockers?.map(b => `${b.kind}: ${b.question ?? b.description}`).join('; ') || 'Implementer blocked';
          } else if (implementation.outcome === 'failed') {
            taskState.status = 'repair_pending';
            taskState.lastError = 'Implementation failed';
          } else {
            await phase('verifying');
            this.options.events?.emit({type:'VERIFICATION_STARTED',taskId:ready.id,attempt:attempt.number});
            await this.options.events?.flush();
            const verification = await this.adapters.verify(context);
            attempt.verification = verification;
            this.options.events?.emit({type:verification.passed?'VERIFICATION_PASSED':'VERIFICATION_FAILED',taskId:ready.id,attempt:attempt.number});
            if (!verification.passed) {
              taskState.status = 'repair_pending';
              taskState.lastError = 'Deterministic verification failed';
            } else if (finalRepair && this.adapters.hasChanges && !(await this.adapters.hasChanges(context))) {
              // Every trusted command passes and nothing was changed: the final failure did not reproduce.
              // There is nothing to review or commit, so the repair is withdrawn below and final verification runs again.
              withdrawn = true;
              taskState.status = 'completed';
            } else {
              await phase('selecting_reviewers');
              const selection = this.adapters.selectReviewers
                ? await this.adapters.selectReviewers(context)
                : { requiredReviewers: [...requiredReviewers], changedFiles: [], reasons: ['Static required reviewers'] };
              const validSelection = (ids: string[]) => ids.includes('code') && new Set(ids).size === ids.length && ids.every(id => requiredReviewers.includes(id));
              if (!validSelection(selection.requiredReviewers)) throw new Error('Invalid reviewer routing selection');
              // A repair or resumed execution may add reviewers, but cannot shed
              // requirements selected on an earlier attempt (including legacy reports).
              const previousSelections = [taskState.reviewSelection, ...taskState.attempts.slice(0, -1).map(a => a.reviewSelection)].filter((s): s is ReviewSelection => s !== undefined);
              const previousIds = [...previousSelections.flatMap(s => s.requiredReviewers), ...taskState.attempts.slice(0, -1).flatMap(a => (a.reviews ?? []).map(r => r.reviewer))];
              const accumulated = [...new Set([...selection.requiredReviewers, ...previousIds])];
              if (!validSelection(accumulated)) throw new Error('Previously required reviewer is no longer enabled');
              const reviewSelection: ReviewSelection = {
                requiredReviewers: requiredReviewers.filter(id => accumulated.includes(id)),
                changedFiles: [...new Set([...previousSelections.flatMap(s => s.changedFiles), ...selection.changedFiles])].sort(),
                reasons: [...new Set([...previousSelections.flatMap(s => s.reasons), ...selection.reasons])]
              };
              taskState.reviewSelection = reviewSelection;
              attempt.reviewSelection = structuredClone(reviewSelection);
              context.requiredReviewers = [...reviewSelection.requiredReviewers];
              taskState.status = 'needs_review';
              await this.store.save(state);
              let evidenceRejected = false;
              if (reviewSelection.requiredReviewers.includes('ui') && this.adapters.collectUiEvidence) {
                await phase('collecting_ui_evidence');
                const uiEvidence = await this.adapters.collectUiEvidence(context);
                attempt.uiEvidence = uiEvidence;
                context.uiEvidence = uiEvidence;
                await this.store.save(state);
                // Failed interaction or accessibility checks are a result of the work, like a failed test.
                // A collector that crashed, timed out or wrote invalid evidence is an environment problem: stop for the operator.
                evidenceRejected = !uiEvidence.passed && (uiEvidence.manifest?.checks ?? []).some(check => check.status === 'failed');
                if (!uiEvidence.passed && !evidenceRejected) throw new Error(`UI evidence rejected: ${uiEvidence.issues.join('; ')}`);
              }
              if (evidenceRejected) {
                // Repair within the budget, with the failed checks as feedback.
                taskState.status = 'repair_pending';
                taskState.lastError = `UI evidence rejected: ${attempt.uiEvidence!.issues.join('; ')}`;
              } else {
                await phase('reviewing');
                this.options.events?.emit({type:'AGENT_STARTED',taskId:ready.id,agent:'reviewer',attempt:attempt.number});
                const reviews = await this.adapters.review(context, implementation, verification, async review => {
                  attempt.reviews ??= [];
                  appendReviewResult(attempt.reviews, review, reviewSelection.requiredReviewers);
                  await this.store.save(state);
                });
                this.options.events?.emit({type:'AGENT_COMPLETED',taskId:ready.id,agent:'reviewer',attempt:attempt.number});
                for (const review of reviews) this.options.events?.emit({type:review.verdict==='approved'?'REVIEW_APPROVED':review.verdict==='changes_requested'?'REVIEW_CHANGES_REQUESTED':'REVIEW_BLOCKED',taskId:ready.id,agent:review.reviewer,attempt:attempt.number});
                attempt.reviews = reconcileReviewResults(attempt.reviews ?? [], reviews);
                const byReviewer = new Map(reviews.map(r => [r.reviewer, r]));
                const validSet = reviews.length === byReviewer.size && reviews.length === reviewSelection.requiredReviewers.length && reviewSelection.requiredReviewers.every(r => byReviewer.has(r));
                if (!validSet || reviews.some(r => r.verdict === 'blocked')) {
                  taskState.status = 'blocked';
                  taskState.lastError = 'Missing, duplicate, or blocked required review';
                } else if (reviews.some(r => r.verdict === 'changes_requested')) {
                  taskState.status = 'repair_pending';
                  taskState.lastError = 'Review requested changes';
                } else {
                  if (this.adapters.checkpoint) {
                    await phase('checkpointing');
                    const result = await this.adapters.checkpoint(context);
                    if (!result.commit) throw new Error('Checkpoint did not return a commit SHA');
                    attempt.checkpointCommit = result.commit;
                    taskState.checkpointCommit = result.commit;
                    this.options.events?.emit({type:'CHECKPOINT_CREATED',taskId:ready.id,attempt:attempt.number,message:result.commit});
                  }
                  taskState.status = 'completed';
                  this.options.events?.emit({type:'TASK_COMPLETED',taskId:ready.id});
                  delete taskState.lastError;
                }
              }
            }
          }
        } catch (error) {
          this.options.events?.emit({type:'AGENT_FAILED',taskId:ready.id,attempt:attempt.number,...(error instanceof AgentExecutionError ? {agent:error.role} : {}),message:error instanceof Error?error.message:String(error)});
          attempt.outcome = 'error';
          const retry = error instanceof AgentExecutionError && error.retryable && consumedInfraRetries(taskState) < maxInfraRetries;
          if (retry) attempt.infraRetry = { role: error.role, error: error.message };
          taskState.status = retry ? 'repair_pending' : 'blocked';
          taskState.lastError = `Agent/verification error: ${error instanceof Error ? error.message : String(error)}; inspect worktree before retrying`;
        } finally {
          attempt.phase = 'finished';
          attempt.finishedAt = new Date().toISOString();
          await this.store.save(state);
        }
      }
      if (withdrawn) {
        const repair = state.finalRepairs!.find(entry => entry.taskId === ready.id)!;
        repair.withdrawn = true;
        const now = new Date().toISOString();
        state.planRevisions = [...(state.planRevisions ?? []), { replacedAt: now, plan: structuredClone(state.plan) }];
        const planned = (state.plan as { tasks?: unknown } | null)?.tasks;
        if (Array.isArray(planned) && planned !== tasks) planned.splice(0, planned.length, ...planned.filter(item => (item as { id?: unknown } | null)?.id !== ready.id));
        tasks.splice(tasks.indexOf(ready), 1);
        ids.delete(ready.id);
        delete state.tasks[ready.id];
        // Attempt history is evidence; the ID is retired like any superseded task.
        state.supersededTasks = [...(state.supersededTasks ?? []), { supersededAt: now, task: { ...taskState, status: 'blocked', lastError: 'Final verification failure did not reproduce; no repair was needed' } }];
        this.options.events?.emit({type:'PLAN_REVISED',taskId:ready.id,message:`Withdrew repair task ${ready.id}: every trusted command passed without changes`});
        await this.store.save(state);
        continue;
      }
      if (taskState.status === 'repair_pending') {
        taskState.status = 'blocked';
        taskState.lastError = `Maximum attempts (${maxAttempts}) exhausted: ${taskState.lastError ?? 'unknown'}`;
        await this.store.save(state);
      }
      if (taskState.status === 'blocked') this.options.events?.emit({type:'TASK_BLOCKED',taskId:ready.id,message:taskState.lastError});
    }
  }
}
