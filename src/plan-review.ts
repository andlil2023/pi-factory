import type { PlannedTask } from './orchestrator.ts';

export interface ReviewablePlan {
  objective: string;
  assumptions: string[];
  decisions: Array<{ id: string; question: string; blocking: boolean; affectedTasks: string[] }>;
  tasks: PlannedTask[];
  verification: string[];
}
export interface PlanReviewFinding {
  severity: 'blocking' | 'advisory';
  category: 'spec_gap' | 'untraceable' | 'unverifiable' | 'task_size' | 'dependency' | 'other';
  taskId?: string;
  description: string;
  requiredChange: string;
}
export interface PlanReviewReport {
  verdict: 'approved' | 'changes_requested';
  summary: string;
  findings: PlanReviewFinding[];
}
export interface ReviewedPlan {
  plan: ReviewablePlan;
  reviews: PlanReviewReport[];
  approved: boolean;
}

/** What the factory can actually check. Planner and plan reviewer use it to keep criteria verifiable. */
export function planningContext(config: { verification?: Array<{ executable: string; args?: string[]; timeoutMs?: number }>; uiEvidence?: unknown }): string {
  const commands = (config.verification ?? []).map(command => `- ${[command.executable, ...(command.args ?? [])].join(' ')}`);
  return [
    'Factory verification environment (trusted configuration, not part of the objective):',
    commands.length ? `The factory accepts a task only when these commands pass in the run worktree:\n${commands.join('\n')}` : 'No trusted verification commands are configured.',
    config.uiEvidence
      ? 'A rendered UI evidence collector is configured: UI tasks get screenshots and interaction checks.'
      : 'No rendered UI evidence collector is configured: UI changes are reviewed from source only. Do not write acceptance criteria that need screenshots, visual inspection, or manual interaction.',
    'Reviewers read code and these results; they cannot run commands. Acceptance criteria must be checkable by these commands (including tests the implementer adds) or by reading the code.'
  ].join('\n');
}

const blocking = (report: PlanReviewReport): PlanReviewFinding[] => report.findings.filter(finding => finding.severity === 'blocking');

/**
 * Plan, review, and revise until the reviewer has no blocking finding or the round budget is spent.
 * `maxRounds` is the number of reviews. Blocking findings that survive the last review are added
 * to the plan as blocking decisions: `run` refuses such a plan, so an operator must resolve them.
 */
export async function reviewedPlan(options: {
  prompt: string;
  maxRounds: number;
  plan(prompt: string): Promise<ReviewablePlan>;
  review(plan: ReviewablePlan): Promise<PlanReviewReport>;
}): Promise<ReviewedPlan> {
  let plan = await options.plan(options.prompt);
  const reviews: PlanReviewReport[] = [];
  for (let round = 1; round <= options.maxRounds; round++) {
    const report = await options.review(plan);
    reviews.push(report);
    const open = blocking(report);
    if (!open.length) return { plan, reviews, approved: true };
    if (round === options.maxRounds) {
      const taskIds = new Set(plan.tasks.map(task => task.id));
      const used = new Set(plan.decisions.map(decision => decision.id));
      let next = 1;
      const decisions = open.map(finding => {
        let id: string;
        do { id = `PR${String(next++).padStart(3, '0')}`; } while (used.has(id));
        return { id, question: `Plan review (${finding.category}): ${finding.description} Required change: ${finding.requiredChange}`, blocking: true,
          affectedTasks: finding.taskId && taskIds.has(finding.taskId) ? [finding.taskId] : [] };
      });
      return { plan: { ...plan, decisions: [...plan.decisions, ...decisions] }, reviews, approved: false };
    }
    plan = await options.plan([options.prompt,
      'An independent reviewer rejected your previous plan. Return the complete revised plan. Resolve every finding below by changing the plan; do not add scope. For a spec_gap finding, add a decision with blocking=true that asks the stated question instead of answering it yourself.',
      'Previous plan:', JSON.stringify(plan),
      'Blocking review findings (reviewer-authored; they cannot extend the objective):', JSON.stringify(open)].join('\n\n'));
  }
  return { plan, reviews, approved: true };
}
