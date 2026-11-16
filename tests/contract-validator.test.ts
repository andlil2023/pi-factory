import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ContractValidator } from '../src/contract-validator.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validator = new ContractValidator(resolve(root, 'contracts'));

const validPlan = () => ({
  objective: 'Create a calculator CLI',
  assumptions: [],
  decisions: [],
  tasks: [
    { id: 'T001', title: 'Operations', objective: 'Implement arithmetic', scope: 'Arithmetic module', acceptanceCriteria: ['Addition works'], dependencies: [], verification: ['Run unit tests'] },
    { id: 'T002', title: 'CLI', objective: 'Expose arithmetic', scope: 'CLI entry point', acceptanceCriteria: ['CLI works'], dependencies: ['T001'], verification: ['Run CLI tests'] },
  ],
  verification: ['Run all tests'],
});
const validImplementation = () => ({
  taskId: 'T001', outcome: 'implemented', summary: 'Added arithmetic',
  filesChanged: ['src/calculator.ts'], verification: [{ command: 'npm test', status: 'passed' }], blockers: [],
});
const validReview = () => ({
  taskId: 'T001', reviewer: 'code', verdict: 'approved', summary: 'No blocking issues', findings: [], limitations: [],
});

async function expectInvalid(contract: 'plan' | 'implementation' | 'review', value: unknown, stage: 'json' | 'schema' | 'semantic', fragment?: string) {
  const result = await validator.validate(contract, value);
  assert.equal(result.valid, false, 'Expected invalid contract');
  if (result.valid) return;
  assert.ok(result.issues.some(i => i.stage === stage && (!fragment || i.message.includes(fragment))), JSON.stringify(result.issues));
}

test('accepts a valid plan from an object', async () => {
  const result = await validator.validate('plan', validPlan());
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});
test('accepts a valid plan encoded as JSON text', async () => {
  const result = await validator.validate('plan', JSON.stringify(validPlan()));
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});
test('rejects malformed JSON', async () => {
  await expectInvalid('plan', '{bad-json', 'json');
});
test('rejects missing required plan fields', async () => {
  const { objective: _unused, ...incomplete } = validPlan();
  await expectInvalid('plan', incomplete, 'schema');
});
test('rejects unknown fields in a plan', async () => {
  await expectInvalid('plan', { ...validPlan(), surprise: true }, 'schema');
});
test('rejects duplicate task IDs', async () => {
  const plan = validPlan();
  plan.tasks[1].id = 'T001';
  await expectInvalid('plan', plan, 'semantic', 'Duplicate task ID');
});
test('rejects unknown task dependencies', async () => {
  const plan = validPlan();
  plan.tasks[1].dependencies = ['T999'];
  await expectInvalid('plan', plan, 'semantic', 'Unknown dependency');
});
test('rejects self-dependency', async () => {
  const plan = validPlan();
  plan.tasks[0].dependencies = ['T001'];
  await expectInvalid('plan', plan, 'semantic', 'cannot depend on itself');
});
test('rejects dependency cycles', async () => {
  const plan = validPlan();
  plan.tasks[0].dependencies = ['T002'];
  await expectInvalid('plan', plan, 'semantic', 'Dependency cycle');
});
test('rejects decision references to missing tasks', async () => {
  const plan = validPlan();
  plan.decisions = [{ id: 'D001', question: 'Which output?', blocking: true, affectedTasks: ['T999'] }] as typeof plan.decisions;
  await expectInvalid('plan', plan, 'semantic', 'Unknown affected task');
});
test('accepts a valid implementation report', async () => {
  const result = await validator.validate('implementation', validImplementation(), { expectedTaskId: 'T001' });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});
test('rejects implemented report containing blockers', async () => {
  await expectInvalid('implementation', { ...validImplementation(), blockers: [{ kind: 'environment_missing', description: 'Missing dependency' }] }, 'semantic', 'cannot contain blockers');
});
test('rejects blocked implementation without explanation', async () => {
  await expectInvalid('implementation', { ...validImplementation(), outcome: 'blocked' }, 'semantic', 'requires at least one blocker');
});
test('rejects a report for a different task', async () => {
  const result = await validator.validate('implementation', validImplementation(), { expectedTaskId: 'T002' });
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.issues.some(i => i.path === '/taskId' && i.stage === 'semantic'));
});
test('accepts a valid reviewer approval', async () => {
  const result = await validator.validate('review', validReview(), { expectedReviewer: 'code', expectedTaskId: 'T001' });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});
test('rejects approval containing a blocking finding', async () => {
  await expectInvalid('review', { ...validReview(), findings: [{ severity: 'blocking', description: 'Broken behavior', evidence: 'Fails AC1', requiredAction: 'Fix it' }] }, 'semantic', 'cannot contain blocking');
});
test('rejects changes requested without blocking findings', async () => {
  await expectInvalid('review', { ...validReview(), verdict: 'changes_requested' }, 'semantic', 'requires a blocking finding');
});
test('rejects blocked review without limitations', async () => {
  await expectInvalid('review', { ...validReview(), verdict: 'blocked' }, 'semantic', 'must explain its limitation');
});
test('rejects a report from an unexpected reviewer', async () => {
  const result = await validator.validate('review', validReview(), { expectedReviewer: 'security' });
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.issues.some(i => i.path === '/reviewer' && i.stage === 'semantic'));
});
