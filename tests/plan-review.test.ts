import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { reviewedPlan, planningContext, type PlanReviewReport, type ReviewablePlan } from '../src/plan-review.ts';
import { ContractValidator } from '../src/contract-validator.ts';

const plan = (marker: string): ReviewablePlan => ({ objective: marker, assumptions: [], decisions: [],
  tasks: [{ id: 'T001', title: 'A', objective: 'A', scope: 'A', acceptanceCriteria: ['A'], dependencies: [], verification: ['test'] }], verification: ['test'] });
const approved: PlanReviewReport = { verdict: 'approved', summary: 'fine', findings: [] };
const rejected = (description: string, taskId?: string): PlanReviewReport => ({ verdict: 'changes_requested', summary: 'no',
  findings: [{ severity: 'blocking', category: 'unverifiable', ...(taskId ? { taskId } : {}), description, requiredChange: 'Make it checkable' },
    { severity: 'advisory', category: 'other', description: 'ADVISORY_ONLY', requiredChange: 'Optional' }] });

test('an approved first plan is returned after one review', async () => {
  const prompts: string[] = [];
  const result = await reviewedPlan({ prompt: 'BASE', maxRounds: 2, plan: async prompt => { prompts.push(prompt); return plan('v1'); }, review: async () => approved });
  assert.equal(result.approved, true);
  assert.equal(result.plan.objective, 'v1');
  assert.deepEqual(prompts, ['BASE']);
  assert.equal(result.reviews.length, 1);
});

test('blocking findings are sent back to the planner with the rejected plan', async () => {
  const prompts: string[] = [];
  const reviewed: string[] = [];
  const result = await reviewedPlan({ prompt: 'BASE', maxRounds: 2,
    plan: async prompt => { prompts.push(prompt); return plan(`v${prompts.length}`); },
    review: async candidate => { reviewed.push(candidate.objective); return reviewed.length === 1 ? rejected('CRITERION_NEEDS_MANUAL_CHECK', 'T001') : approved; } });
  assert.equal(result.approved, true);
  assert.equal(result.plan.objective, 'v2');
  assert.deepEqual(reviewed, ['v1', 'v2']);
  assert.ok(prompts[1].startsWith('BASE'));
  assert.match(prompts[1], /CRITERION_NEEDS_MANUAL_CHECK/);
  assert.match(prompts[1], /"objective":"v1"/);
  assert.doesNotMatch(prompts[1], /ADVISORY_ONLY/);
  assert.deepEqual(result.plan.decisions, []);
});

test('findings that survive the last round become blocking decisions, so the run cannot start silently', async () => {
  let plans = 0;
  const result = await reviewedPlan({ prompt: 'BASE', maxRounds: 2, plan: async () => plan(`v${++plans}`), review: async () => rejected('STILL_UNVERIFIABLE', 'T001') });
  assert.equal(result.approved, false);
  assert.equal(plans, 2, 'one revision between two reviews');
  assert.equal(result.reviews.length, 2);
  assert.deepEqual(result.plan.decisions, [{ id: 'PR001', question: 'Plan review (unverifiable): STILL_UNVERIFIABLE Required change: Make it checkable', blocking: true, affectedTasks: ['T001'] }]);
  const validation = await new ContractValidator(resolve('contracts')).validate('plan', result.plan);
  assert.equal(validation.valid, true);
});

test('a finding for an unknown task does not produce an invalid plan', async () => {
  const result = await reviewedPlan({ prompt: 'BASE', maxRounds: 1, plan: async () => plan('v1'), review: async () => rejected('GLOBAL', 'T999') });
  assert.deepEqual(result.plan.decisions[0].affectedTasks, []);
});

test('zero rounds skips review', async () => {
  const result = await reviewedPlan({ prompt: 'BASE', maxRounds: 0, plan: async () => plan('v1'), review: async () => { throw new Error('must not review'); } });
  assert.equal(result.approved, true);
  assert.equal(result.reviews.length, 0);
});

test('a rejection without blocking findings is treated as approval', async () => {
  const result = await reviewedPlan({ prompt: 'BASE', maxRounds: 2, plan: async () => plan('v1'),
    review: async () => ({ verdict: 'changes_requested', summary: 'style', findings: [{ severity: 'advisory', category: 'other', description: 'x', requiredChange: 'y' }] }) });
  assert.equal(result.approved, true);
  assert.deepEqual(result.plan.decisions, []);
});

test('planning context names trusted commands and UI evidence availability without timeouts', () => {
  const text = planningContext({ verification: [{ executable: 'node', args: ['--test'], timeoutMs: 5 }], uiEvidence: undefined });
  assert.match(text, /node --test/);
  assert.match(text, /No rendered UI evidence collector is configured/);
  assert.doesNotMatch(text, /timeoutMs/);
  assert.match(planningContext({ verification: [], uiEvidence: { command: { executable: 'x' } } }), /A rendered UI evidence collector is configured/);
});
