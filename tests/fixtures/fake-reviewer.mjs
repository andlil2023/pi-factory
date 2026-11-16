// Deterministic reviewer process: no model or network access.
import { readFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const prompt = args.at(-1);
const id = /Use reviewer="([a-z]+)"/.exec(prompt)?.[1];
const mode = args[0];
const report = {
  taskId: mode === 'wrong-task' && id === 'security' ? 'T999' : /"id":"(T\d+)"/.exec(prompt)?.[1] ?? 'T001',
  reviewer: mode === 'wrong-reviewer' && id === 'security' ? 'code' : id,
  verdict: mode === 'blocked' && id === 'ui' ? 'blocked' : 'approved',
  summary: JSON.stringify({ args, pid: process.pid }),
  findings: [],
  limitations: mode === 'blocked' && id === 'ui' ? ['Missing rendered evidence'] : []
};
if (mode === 'partial-failure' && id === 'security') {
  report.verdict = 'changes_requested';
  report.findings = [{ severity: 'blocking', description: 'PRIOR_SECURITY_FINDING_7821', evidence: 'Fixture trust-boundary defect', requiredAction: 'Reassess against current integration' }];
}
if (mode === 'partial-failure' && id === 'ui' && args[1] && !args[1].startsWith('--')) {
  const saved = JSON.parse(await readFile(args[1], 'utf8'));
  const prior = saved.integrations.at(-1).reviews;
  if (prior?.length !== 2 || !JSON.stringify(prior).includes('PRIOR_SECURITY_FINDING_7821')) throw new Error('Prior reports were not persisted before invoking UI');
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [
  { type: 'text', text: (mode === 'invalid' && id === 'security') || (mode === 'partial-failure' && id === 'ui') ? '{}' : JSON.stringify(report) }
] } }));
