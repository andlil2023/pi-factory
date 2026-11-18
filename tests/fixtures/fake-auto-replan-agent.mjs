// Deterministic fixture for reviewed planning and automatic replanning. No PI or network calls.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { prompt } from './pi-input.mjs';

const task = (id, dependencies, criterion) => ({ id, title: `Task ${id}`, objective: 'Write a fixture file', scope: `${id}.txt`, acceptanceCriteria: [criterion], dependencies, verification: ['trusted-check'] });
let report;
if (prompt.startsWith('Plan the following objective')) {
  if (!prompt.includes('Factory verification environment')) throw new Error('Planner prompt lacks the verification environment');
  const revised = prompt.includes('An independent reviewer rejected your previous plan');
  if (revised && !prompt.includes('NEEDS_HUMAN_EYES')) throw new Error('Revision prompt lacks the review finding');
  const criterion = revised ? 'Fixture file exists' : 'Looks good to a human';
  report = { objective: 'Fixture', assumptions: [], decisions: [], tasks: [task('T001', [], criterion), task('T002', ['T001'], criterion)], verification: ['trusted-check'] };
} else if (prompt.startsWith('Review this plan')) {
  if (!prompt.includes('Factory verification environment')) throw new Error('Plan review prompt lacks the verification environment');
  const rejected = prompt.includes('Looks good to a human');
  report = rejected
    ? { verdict: 'changes_requested', summary: 'Unverifiable criterion', findings: [{ severity: 'blocking', category: 'unverifiable', taskId: 'T001', description: 'NEEDS_HUMAN_EYES', requiredChange: 'State a checkable behavior' }] }
    : { verdict: 'approved', summary: 'Plan is executable', findings: [] };
} else if (prompt.startsWith('Revise the plan')) {
  if (!prompt.includes('no operator is present')) throw new Error('Automatic replan prompt lacks the factory instruction');
  if (!prompt.includes('task_too_large')) throw new Error('Replan prompt lacks the blocker');
  const plan = JSON.parse(/Current plan:\n\n(.*)\n/.exec(prompt)[1]);
  const [first, large] = plan.tasks;
  report = { ...plan, tasks: [first, { ...large, id: 'T003', title: 'First half' }, { ...large, id: 'T004', title: 'Second half', dependencies: ['T003'] }] };
} else {
  const taskId = /"id":"(T\d+)"/.exec(prompt)?.[1];
  if (prompt.startsWith('Implement ONLY')) {
    const blocked = taskId === 'T002';
    // A too-large task leaves partial work behind; replacement tasks must start from a clean checkpoint.
    if (blocked) await writeFile('partial.txt', 'PARTIAL_WORK_OF_T002');
    else if (existsSync('partial.txt')) throw new Error('Leftover edits of the superseded task were not removed');
    else await writeFile(`${taskId}.txt`, `Task ${taskId}`);
    report = { taskId, outcome: blocked ? 'blocked' : 'implemented', summary: blocked ? 'Too large' : 'Implemented', filesChanged: blocked ? [] : [`${taskId}.txt`], verification: [],
      blockers: blocked ? [{ kind: 'task_too_large', description: 'Two independent halves', proposedSplit: ['First half', 'Second half'] }] : [] };
  } else {
    report = { taskId, reviewer: 'code', verdict: 'approved', summary: 'Fixture review approved', findings: [], limitations: [] };
  }
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(report) }] } }));
