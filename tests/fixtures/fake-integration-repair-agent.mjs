import { writeFile } from 'node:fs/promises';
import { prompt } from './pi-input.mjs';

const mode = process.argv[2];
const taskId = /"id":"(T\d+)"/.exec(prompt)?.[1];
let report;
if (prompt.startsWith('Implement ONLY')) {
  const blocked = taskId !== 'T001' && mode === 'incomplete';
  if (!blocked && !(taskId !== 'T001' && mode === 'withdraw')) await writeFile(`${taskId}.txt`, `Changes for ${taskId}`);
  report = { taskId, outcome: blocked ? 'blocked' : 'implemented', summary: blocked ? 'Need guidance' : 'Implemented', filesChanged: blocked ? [] : [`${taskId}.txt`], verification: [], blockers: blocked ? [{kind:'decision_needed',description:'Need guidance',question:'What next?'}] : [] };
} else {
  const integration = taskId === 'T000';
  const reject = integration && (mode === 'always' || process.cwd().includes('attempt-1'));
  report = { taskId, reviewer:'code', verdict: reject ? 'changes_requested' : 'approved', summary: reject ? 'Fix integration' : 'Approved', findings: reject ? [{severity:'blocking',description:'Integration issue',evidence:'Merged result',requiredAction:'Fix issue'}] : [], limitations:[] };
}
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(report)}]}}));
