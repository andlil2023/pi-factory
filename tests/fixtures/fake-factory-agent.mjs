// Deterministic end-to-end factory agent fixture. No PI or network calls.
import { readFile, writeFile } from 'node:fs/promises';
import { prompt } from './pi-input.mjs';
const taskId = /"id":"(T\d+)"/.exec(prompt)?.[1];
let report;
if (prompt.startsWith('Implement ONLY')) {
  const attempt = Number(/Attempt:\n\n(\d+)/.exec(prompt)?.[1]);
  const blocked = taskId === 'T002' && attempt === 1;
  const file = `${taskId}.txt`;
  if (attempt > 1) {
    if (!prompt.includes('Inspect fixture work before retry')) throw new Error('Missing prior blocker feedback');
    if (!prompt.includes('Operator says proceed')) throw new Error('Missing operator guidance');
    if (!(await readFile(file, 'utf8')).includes('attempt 1')) throw new Error('Prior work was not preserved');
  }
  await writeFile(file, `Task ${taskId}, attempt ${attempt}`);
  report = { taskId, outcome: blocked ? 'blocked' : 'implemented', summary: blocked ? 'Fixture needs operator inspection' : 'Implemented', filesChanged: [file], verification: [], blockers: blocked ? [{ kind: 'decision_needed', description: 'Inspect fixture work before retry', question: 'May the fixture proceed?' }] : [] };
} else {
  report = { taskId, reviewer: 'code', verdict: 'approved', summary: 'Fixture review approved', findings: [], limitations: [] };
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(report) }] } }));
