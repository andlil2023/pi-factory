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

async function expectInvalid(contract: 'plan' | 'implementation' | 'review' | 'impact' | 'spec-review', value: unknown, stage: 'json' | 'schema' | 'semantic', fragment?: string) {
  const result = await validator.validate(contract, value);
  assert.equal(result.valid, false, 'Expected invalid contract');
  if (result.valid) return;
  assert.ok(result.issues.some(i => i.stage === stage && (!fragment || i.message.includes(fragment))), JSON.stringify(result.issues));
}

test('validates specification review findings and rejects malformed replies', async () => {
  const finding = { category: 'spec_gap', section: 'Requirements', description: 'A decision is open', question: 'Which behavior is required?' };
  for (const value of [{ findings: [] }, { findings: [finding, { ...finding, category: 'unverifiable' }] }]) {
    assert.equal((await validator.validate('spec-review', JSON.stringify(value))).valid, true);
  }
  await expectInvalid('spec-review', '{bad-json', 'json');
  for (const value of [null, [], {}, { findings: null }, { findings: [], extra: true },
    { findings: [{ ...finding, category: 'other' }] }, { findings: [{ ...finding, extra: true }] },
    ...Object.keys(finding).map(key => ({ findings: [Object.fromEntries(Object.entries(finding).filter(([name]) => name !== key))] })),
    ...['section', 'description', 'question'].flatMap(key => [{ findings: [{ ...finding, [key]: '' }] }, { findings: [{ ...finding, [key]: 42 }] }]),
  ]) await expectInvalid('spec-review', value, 'schema');
});

test('validates impact structure and permits nonexistent relative paths', async () => {
  const impact = { affectedModules: [{ path: 'not-yet-created/module.ts', change: 'The module may change.' }, { path: 'future\\module', change: 'Another area may change' }], consequences: ['Tests may need updates.'] };
  assert.equal((await validator.validate('impact', JSON.stringify(impact))).valid, true);
  assert.equal((await validator.validate('impact', { affectedModules: [], consequences: [] })).valid, true);
  for (const invalid of [ {}, { ...impact, extra: true }, { ...impact, affectedModules: [{ path: 'src' }] }, { ...impact, consequences: [42] }, { ...impact, affectedModules: [{ path: 'src', change: 'Change', extra: true }] } ]) {
    await expectInvalid('impact', invalid, 'schema');
  }
});

test('rejects non-relative and traversal impact paths on all platforms', async () => {
  for (const path of ['', ' ', '/root/file', '\\root\\file', 'C:\\file', 'C:file', '\\\\server\\share', '../file', 'src/../file', 'src\\..\\file']) {
    const result = await validator.validate('impact', { affectedModules: [{ path, change: 'May change.' }], consequences: [] });
    assert.equal(result.valid, false, `accepted ${JSON.stringify(path)}`);
  }
  for (const path of ['src/.../file', './src/file', 'src/foo..bar']) {
    assert.equal((await validator.validate('impact', { affectedModules: [{ path, change: 'May change.' }], consequences: [] })).valid, true, path);
  }
});

test('rejects multiline, blank and multiple-sentence impact text', async () => {
  for (const text of ['', '   ', 'First line\nSecond line', 'First\rSecond', 'First\u2028Second', 'First. Second.', 'First! Second?', 'First? Second']) {
    for (const impact of [
      { affectedModules: [{ path: 'src', change: text }], consequences: [] },
      { affectedModules: [], consequences: [text] },
    ]) assert.equal((await validator.validate('impact', impact)).valid, false, JSON.stringify(text));
  }
});

test('recognizes sentence boundaries after closing quotes and brackets in both impact fields', async () => {
  for (const text of [
    '"Tests may change." "Documentation may change."',
    '“The module changes.” Tests need updates.',
    '(Tests may change.) Documentation may change.',
    '[Tests may change!] Documentation may change.',
    '“(Tests may change.)” Documentation may change.',
  ]) {
    for (const impact of [
      { affectedModules: [{ path: 'src', change: text }], consequences: [] },
      { affectedModules: [], consequences: [text] },
    ]) await expectInvalid('impact', impact, 'semantic', 'one-sentence');
  }
  for (const text of ['"Tests may change."', '“Tests may change.”', '(Tests may change.)']) {
    const impact = { affectedModules: [{ path: 'src', change: text }], consequences: [text] };
    assert.equal((await validator.validate('impact', impact)).valid, true, text);
  }
});

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
