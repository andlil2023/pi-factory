import type { PlannedTask } from './orchestrator.ts';
import type { FactoryRunState, IntegrationAttempt } from './state-store.ts';

/** Decide solely from the saved candidate and run state. The caller still checks live Git refs. */
export function integrationRepairEligible(state: FactoryRunState, candidate: IntegrationAttempt, maxRepairs: number): boolean {
  const attempt = state.integrations?.at(-1);
  if (!attempt || attempt.number !== candidate.number) return false;
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || (state.integrationRepairs?.length ?? 0) >= maxRepairs) return false;
  if (state.status !== 'completed' || !state.finalVerification?.passed || !Object.keys(state.tasks).length
    || Object.values(state.tasks).some(task => task.status !== 'completed')) return false;
  if (!state.execution || !Number.isSafeInteger(state.execution.maxAttempts) || state.execution.maxAttempts < 1
    || (state.integrations?.length ?? 0) >= state.execution.maxAttempts
    || state.integrationRepairs?.some(repair => repair.integrationAttempt === attempt.number)) return false;
  if (attempt.status !== 'blocked' || !attempt.commit || !state.git
    || attempt.targetBranch !== state.git.targetBranch || attempt.sourceHead !== state.git.expectedHead
    || !attempt.targetHead || !attempt.sourceHead) return false;
  // A blocked reviewer is an escalation, not an actionable changes request.
  if (attempt.reviews?.some(review => review.verdict === 'blocked')) return false;
  if (attempt.failedPhase === 'verifying') return attempt.verification?.passed === false;
  if (attempt.failedPhase === 'reviewing') return attempt.verification?.passed === true
    && !!attempt.reviews?.some(review => review.verdict === 'changes_requested');
  if (attempt.failedPhase === 'collecting_ui_evidence') return attempt.verification?.passed === true
    && attempt.uiEvidence?.passed === false
    && !!attempt.uiEvidence.manifest?.checks.some(check => check.status === 'failed');
  return false;
}

/** Return a new snapshot; neither the rejected attempt nor the input state is modified. */
export function addIntegrationRepair(state: FactoryRunState, attempt: IntegrationAttempt, maxRepairs: number, now: string = new Date().toISOString()): FactoryRunState {
  if (!integrationRepairEligible(state, attempt, maxRepairs)) throw new Error('Integration attempt is not eligible for repair');
  const plan = state.plan as { tasks?: PlannedTask[] } | null;
  if (!plan || !Array.isArray(plan.tasks)) throw new Error('Invalid run plan');
  const numbers = [...plan.tasks.map(task => task.id), ...Object.keys(state.tasks), ...(state.supersededTasks ?? []).map(entry => entry.task.id)]
    .map(id => Number(/^T(\d+)$/.exec(id)?.[1])).filter(Number.isSafeInteger);
  const id = `T${String(Math.max(0, ...numbers) + 1).padStart(3, '0')}`;
  const task: PlannedTask = {
    id,
    title: 'Repair integration rejection',
    objective: 'Fix the rejection of the combined integration candidate.',
    scope: 'Fix the issues in the integration feedback without weakening tests or changing behavior accepted by earlier tasks. The feedback describes the merged result, not just the run branch.',
    acceptanceCriteria: ['The integration rejection is addressed', 'Previously accepted behavior and tests are preserved'],
    dependencies: plan.tasks.map(item => item.id),
    verification: ['Run focused tests for the integration feedback']
  };
  const result = structuredClone(state);
  (result.plan as { tasks: PlannedTask[] }).tasks.push(task);
  result.planRevisions = [...(result.planRevisions ?? []), { replacedAt: now, plan: structuredClone(state.plan) }];
  result.tasks[id] = { id, status: 'pending', attempts: [] };
  result.integrationRepairs = [...(result.integrationRepairs ?? []), { at: now, taskId: id, integrationAttempt: attempt.number }];
  return result;
}
