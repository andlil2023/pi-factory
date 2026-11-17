import { writeFile } from 'node:fs/promises';
import { prompt } from './pi-input.mjs';
const taskId = /"id":"(T\d+)"/.exec(prompt)?.[1];
let report;
if (prompt.startsWith('Implement ONLY')) {
  const attempt = Number(/Attempt:\n\n(\d+)/.exec(prompt)?.[1]);
  const file = taskId === 'T001' ? 'accepted.txt' : attempt === 1 ? 'first.txt' : 'repair.txt';
  await writeFile(file, 'fixture');
  const blocked = taskId === 'T002' && attempt === 1;
  report = { taskId, outcome: blocked ? 'blocked' : 'implemented', summary: 'fixture', filesChanged: [file], verification: [], blockers: blocked ? [{ kind: 'decision_needed', description: 'Pause for retry', question: 'Proceed?' }] : [] };
} else {
  report = { taskId, reviewer: 'code', verdict: 'approved', summary: 'approved', findings: [], limitations: [] };
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(report) }] } }));
