import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { ContractValidator, MAX_ACCEPTANCE_CRITERIA, MAX_CRITERION_LENGTH } from '../src/contract-validator.ts';

const validator = new ContractValidator(resolve(import.meta.dirname, '..', 'contracts'));
const blocked = (blockers: unknown[]) => ({ taskId: 'T001', outcome: 'blocked', summary: 'Stopped', filesChanged: [], verification: [], blockers });
const plan = (acceptanceCriteria: string[]) => ({
  objective: 'Demo', assumptions: [], decisions: [], verification: ['Run tests'],
  tasks: [{ id: 'T001', title: 'A', objective: 'A', scope: 'A', acceptanceCriteria, dependencies: [], verification: ['Run tests'] }]
});
async function issues(contract: 'plan' | 'implementation', value: unknown, options = {}): Promise<string> {
  const result = await validator.validate(contract, value, options);
  return result.valid ? '' : JSON.stringify(result.issues);
}

test('accepts a decision blocker that asks a specific question', async () => {
  assert.equal(await issues('implementation', blocked([{ kind: 'decision_needed', description: 'Two valid formats exist', question: 'Should output be JSON or CSV?' }])), '');
});
test('accepts an environment blocker and a too-large blocker with a proposed split', async () => {
  assert.equal(await issues('implementation', blocked([
    { kind: 'environment_missing', description: 'No browser is installed for rendered checks' },
    { kind: 'task_too_large', description: 'Seven subsystems in one task', proposedSplit: ['Protocol types', 'Worker process'] }
  ])), '');
});
test('rejects free-text blockers that carry no kind', async () => {
  assert.match(await issues('implementation', blocked(['Worker isolation remains unimplemented.'])), /"stage":"schema"/);
});
test('rejects an unknown blocker kind', async () => {
  assert.match(await issues('implementation', blocked([{ kind: 'unimplemented', description: 'Work remains' }])), /"stage":"schema"/);
});
test('rejects a decision blocker without a question', async () => {
  assert.match(await issues('implementation', blocked([{ kind: 'decision_needed', description: 'Unclear' }])), /requires a question/);
});
test('rejects a too-large blocker without at least two proposed parts', async () => {
  assert.match(await issues('implementation', blocked([{ kind: 'task_too_large', description: 'Big', proposedSplit: ['Everything'] }])), /proposedSplit/);
});

test('task size gate rejects too many acceptance criteria only when enforced', async () => {
  const oversized = plan(Array.from({ length: MAX_ACCEPTANCE_CRITERIA + 1 }, (_, index) => `Criterion ${index}`));
  assert.match(await issues('plan', oversized, { enforceTaskSize: true }), /acceptance criteria/);
  // Persisted plans of existing runs must stay loadable.
  assert.equal(await issues('plan', oversized), '');
});
test('task size gate rejects a criterion that bundles many requirements', async () => {
  assert.match(await issues('plan', plan(['x'.repeat(MAX_CRITERION_LENGTH + 1)]), { enforceTaskSize: true }), /characters/);
  assert.equal(await issues('plan', plan(['x'.repeat(MAX_CRITERION_LENGTH)]), { enforceTaskSize: true }), '');
});
