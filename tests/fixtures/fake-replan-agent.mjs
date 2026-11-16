// Deterministic fixture: T002 reports task_too_large; the planner splits it. No PI or network calls.
import { writeFile } from 'node:fs/promises';
import { prompt } from './pi-input.mjs';
let report;
if (prompt.startsWith('Revise the plan')) {
  if (!prompt.includes('task_too_large')) throw new Error('Replan prompt lacks the blocker');
  if (!prompt.includes('Split by file')) throw new Error('Replan prompt lacks operator guidance');
  const plan = JSON.parse(/Current plan:\n\n(.*)\n/.exec(prompt)[1]);
  const [first, large] = plan.tasks;
  report = { ...plan, tasks: [first, { ...large, id: 'T003', title: 'First half' }, { ...large, id: 'T004', title: 'Second half', dependencies: ['T003'] }] };
} else {
  const taskId = /"id":"(T\d+)"/.exec(prompt)?.[1];
  if (prompt.startsWith('Implement ONLY')) {
    const blocked = taskId === 'T002';
    if (!blocked) await writeFile(`${taskId}.txt`, `Task ${taskId}`);
    report = { taskId, outcome: blocked ? 'blocked' : 'implemented', summary: blocked ? 'Too large' : 'Implemented', filesChanged: blocked ? [] : [`${taskId}.txt`], verification: [],
      blockers: blocked ? [{ kind: 'task_too_large', description: 'Two independent halves', proposedSplit: ['First half', 'Second half'] }] : [] };
  } else {
    report = { taskId, reviewer: 'code', verdict: 'approved', summary: 'Fixture review approved', findings: [], limitations: [] };
  }
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(report) }] } }));
