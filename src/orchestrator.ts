import type { FactoryEventBus } from './event-bus.ts';
import { appendReviewResult, reconcileReviewResults } from './review-results.ts';
import type { ReviewSelection } from './review-routing.ts';
import type { UiEvidenceRecord } from './ui-evidence.ts';
import type { FactoryRunState, StateStore, AttemptRecord, ReviewVerdict } from './state-store.ts';

export interface PlannedTask {
  id: string;
  title: string;
  objective: string;
  scope: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  verification: string[];
}
export interface ImplementationResult {
  outcome: 'implemented' | 'blocked' | 'failed';
  report: unknown;
  blockers?: string[];
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
  requiredReviewers?: string[];
  uiEvidence?: UiEvidenceRecord;
}
export interface OrchestratorAdapters {
  implement(context: TaskContext): Promise<ImplementationResult>;
  verify(context: TaskContext): Promise<VerificationResult>;
  selectReviewers?(context: TaskContext): Promise<ReviewSelection>;
  collectUiEvidence?(context: TaskContext): Promise<UiEvidenceRecord>;
  review(context: TaskContext, implementation: ImplementationResult, verification: VerificationResult, onReview?: ReviewProgress): Promise<ReviewResult[]>;
  checkpoint?(context: TaskContext): Promise<{ commit: string }>;
  finalVerify?(): Promise<VerificationResult>;
}
export interface OrchestratorOptions {
  maxAttempts?: number;
  requiredReviewers?: string[];
  events?: FactoryEventBus;
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
          try {
            const final = await this.adapters.finalVerify();
            state.finalVerification = { ...final, checkedAt: new Date().toISOString() };
            this.options.events?.emit({type: final.passed ? 'FINAL_VERIFICATION_PASSED' : 'FINAL_VERIFICATION_FAILED'});
            if (!final.passed) {
              state.status = 'blocked';
              this.options.events?.emit({type:'RUN_BLOCKED', message:'Final verification failed'});
              await this.store.save(state);
              return state;
            }
          } catch (error) {
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
      this.options.events?.emit({type:'TASK_STARTED',taskId:ready.id});
      while (taskState.attempts.length < maxAttempts && taskState.status !== 'completed' && taskState.status !== 'blocked') {
        const attempt: AttemptRecord = { number: taskState.attempts.length + 1, startedAt: new Date().toISOString() };
        taskState.attempts.push(attempt);
        taskState.status = 'running';
        await this.store.save(state);
        const feedback = taskState.attempts.slice(0, -1).flatMap(a => [
          ...(a.outcome === 'blocked' || a.outcome === 'failed' || a.outcome === 'interrupted' ? [a.implementationReport] : []),
          a.verification, ...(a.reviews ?? []).map(r => r.report),
          ...(a.uiEvidence && !a.uiEvidence.passed ? [a.uiEvidence] : [])
        ].filter(x => x !== undefined));
        const context: TaskContext = { task: ready, plan: structuredClone(state.plan), attempt: attempt.number, previousFeedback: feedback };
        if (attempt.number > 1) this.options.events?.emit({type:'REPAIR_STARTED',taskId:ready.id,attempt:attempt.number});
        try {
          this.options.events?.emit({type:'AGENT_STARTED',taskId:ready.id,agent:'implementer',attempt:attempt.number});
          const implementation = await this.adapters.implement(context);
          this.options.events?.emit({type:'AGENT_COMPLETED',taskId:ready.id,agent:'implementer',attempt:attempt.number,message:implementation.outcome});
          attempt.implementationReport = implementation.report;
          attempt.outcome = implementation.outcome === 'implemented' ? 'implemented' : implementation.outcome;
          if (implementation.outcome === 'blocked') {
            taskState.status = 'blocked';
            taskState.lastError = implementation.blockers?.join('; ') || 'Implementer blocked';
          } else if (implementation.outcome === 'failed') {
            taskState.status = 'repair_pending';
            taskState.lastError = 'Implementation failed';
          } else {
            const verification = await this.adapters.verify(context);
            attempt.verification = verification;
            this.options.events?.emit({type:verification.passed?'VERIFICATION_PASSED':'VERIFICATION_FAILED',taskId:ready.id,attempt:attempt.number});
            if (!verification.passed) {
              taskState.status = 'repair_pending';
              taskState.lastError = 'Deterministic verification failed';
            } else {
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
              if (reviewSelection.requiredReviewers.includes('ui') && this.adapters.collectUiEvidence) {
                const uiEvidence = await this.adapters.collectUiEvidence(context);
                attempt.uiEvidence = uiEvidence;
                context.uiEvidence = uiEvidence;
                await this.store.save(state);
                if (!uiEvidence.passed) throw new Error(`UI evidence rejected: ${uiEvidence.issues.join('; ')}`);
              }
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
        } catch (error) {
          this.options.events?.emit({type:'AGENT_FAILED',taskId:ready.id,attempt:attempt.number,message:error instanceof Error?error.message:String(error)});
          attempt.outcome = 'failed';
          taskState.status = 'blocked';
          taskState.lastError = `Agent/verification error: ${error instanceof Error ? error.message : String(error)}; inspect worktree before retrying`;
        } finally {
          attempt.finishedAt = new Date().toISOString();
          await this.store.save(state);
        }
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
