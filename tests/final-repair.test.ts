import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.ts';
import { Orchestrator, type OrchestratorAdapters, type PlannedTask, type TaskContext } from '../src/orchestrator.ts';
import { autoReplanCandidate } from '../src/auto-replan.ts';
import { buildAttemptFeedback, buildFinalFailureFeedback } from '../src/attempt-feedback.ts';
import { configurationFingerprint, fingerprintForRun } from '../src/run-recovery.ts';
import { selectVerification } from '../src/verification-selector.ts';
import { validateSelectionConfig } from '../src/selection-config.ts';

const task = (id: string, dependencies: string[] = []): PlannedTask => ({ id, title: id, objective: id, scope: id, acceptanceCriteria: [id], dependencies, verification: ['test'] });
const failedFinal = { passed: false, details: { mode: 'full', checks: [{ command: 'node --test', passed: false, stdout: 'not ok 4 - combined behavior breaks', stderr: '', failures: ['not ok 4 - combined behavior breaks'], logFile: '/logs/FINAL-1-1.log' }] } };

async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-final-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const tasks = [task('T001'), task('T002', ['T001'])];
  const state = await store.create(dir, { objective: 'demo', assumptions: [], decisions: [], tasks: structuredClone(tasks), verification: ['test'] }, tasks.map(item => item.id), 'final-repair');
  return { store, state, tasks };
}

test('a failed final verification adds a fully verified, reviewed repair task and then passes', async t => {
  const { store, state, tasks } = await fixture(t);
  const contexts: TaskContext[] = [];
  let finals = 0;
  const adapters: OrchestratorAdapters = {
    implement: async context => { contexts.push(structuredClone({ ...context, onVerificationProgress: undefined })); return { outcome: 'implemented', report: {} }; },
    verify: async context => ({ passed: true, details: { mode: context.fullVerification ? 'full' : 'selected' } }),
    review: async () => [{ reviewer: 'code', verdict: 'approved', report: {} }],
    finalVerify: async () => ++finals === 1 ? failedFinal : { passed: true, details: {}, tree: 'a'.repeat(40) }
  };
  const result = await new Orchestrator(store, adapters, { maxFinalRepairs: 2 }).execute(state, tasks);
  assert.equal(result.status, 'completed');
  assert.equal(finals, 2);
  assert.deepEqual(Object.keys(result.tasks), ['T001', 'T002', 'T003']);
  const repair = contexts.find(context => context.task.id === 'T003')!;
  assert.equal(repair.fullVerification, true, 'the repair is verified with every trusted command');
  assert.deepEqual(repair.task.dependencies, ['T001', 'T002']);
  assert.equal(repair.feedback?.open.reason, 'Final verification of the completed run failed');
  assert.deepEqual(repair.feedback?.open.failedChecks[0].failures, ['not ok 4 - combined behavior breaks']);
  assert.equal(repair.feedback?.open.failedChecks[0].logFile, '/logs/FINAL-1-1.log');
  assert.equal(contexts.find(context => context.task.id === 'T001')!.fullVerification, undefined);
  const saved = await store.load(state.runId);
  assert.equal(saved.finalRepairs?.length, 1);
  assert.equal(saved.finalRepairs![0].taskId, 'T003');
  assert.equal(saved.finalVerification?.tree, 'a'.repeat(40));
  assert.deepEqual((saved.plan as { tasks: PlannedTask[] }).tasks.map(item => item.id), ['T001', 'T002', 'T003'], 'the persisted plan matches task state, so the run can be resumed');
  assert.equal(saved.planRevisions?.length, 1);
  assert.equal(saved.tasks.T003.attempts[0].verification && (saved.tasks.T003.attempts[0].verification as { details: { mode: string } }).details.mode, 'full');
});

test('final repairs are bounded and disabled by default', async t => {
  for (const [budget, expectedTasks] of [[undefined, 2], [0, 2], [2, 4]] as const) {
    const { store, state, tasks } = await fixture(t);
    let finals = 0;
    const result = await new Orchestrator(store, {
      implement: async () => ({ outcome: 'implemented', report: {} }),
      verify: async () => ({ passed: true, details: {} }),
      review: async () => [{ reviewer: 'code', verdict: 'approved', report: {} }],
      finalVerify: async () => { finals++; return failedFinal; }
    }, budget === undefined ? {} : { maxFinalRepairs: budget }).execute(state, tasks);
    assert.equal(result.status, 'blocked');
    assert.equal(Object.keys(result.tasks).length, expectedTasks);
    assert.equal(finals, (budget ?? 0) + 1);
    assert.equal(result.finalVerification?.passed, false);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('a repair task that cannot be completed blocks the run and is never replanned automatically', async t => {
  const { store, state, tasks } = await fixture(t);
  const result = await new Orchestrator(store, {
    implement: async () => ({ outcome: 'implemented', report: {} }),
    verify: async context => ({ passed: context.task.id !== 'T003', details: {} }),
    review: async () => [{ reviewer: 'code', verdict: 'approved', report: {} }],
    finalVerify: async () => failedFinal
  }, { maxFinalRepairs: 1, maxAttempts: 2 }).execute(state, tasks);
  assert.equal(result.status, 'blocked');
  assert.match(result.tasks.T003.lastError!, /Maximum attempts \(2\) exhausted/);
  assert.equal(autoReplanCandidate(result, 2, 2), undefined);
});

test('final failure feedback and timeout notes guide the next session', () => {
  const final = buildFinalFailureFeedback(failedFinal);
  assert.equal(final.history.length, 0);
  assert.match(final.notes[0], /combined result/);
  const timedOut = buildAttemptFeedback([{ number: 1, startedAt: 'a', finishedAt: 'b', outcome: 'error', infraRetry: { role: 'implementer', error: 'implementer: PI timed out after 600000 ms' } }])!;
  assert.ok(timedOut.notes.some(note => /session time limit/.test(note) && /do not run a full test suite/.test(note)));
  const crashed = buildAttemptFeedback([{ number: 1, startedAt: 'a', finishedAt: 'b', outcome: 'error', infraRetry: { role: 'implementer', error: 'implementer: PI exited with code 1' } }])!;
  assert.ok(!crashed.notes.some(note => /time limit/.test(note)));
});

test('time limits can change between resumes; every other setting is still pinned', () => {
  const config = { agents: { implementer: { provider: 'p', model: 'm', timeoutMs: 600000 } }, verification: [{ executable: 'node', args: ['--test'], timeoutMs: 600000 }], execution: { maxAttempts: 3 } };
  const longer = structuredClone(config); longer.agents.implementer.timeoutMs = 1200000; longer.verification[0].timeoutMs = 1;
  assert.equal(configurationFingerprint(config), configurationFingerprint(longer));
  const other = structuredClone(config); other.execution.maxAttempts = 4;
  assert.notEqual(configurationFingerprint(config), configurationFingerprint(other));
  const model = structuredClone(config); model.agents.implementer.model = 'other';
  assert.notEqual(configurationFingerprint(config), configurationFingerprint(model));
  // A run started before time limits were excluded recorded the timeout-sensitive form and keeps its strict comparison.
  const legacy = configurationFingerprint(config, true);
  assert.notEqual(legacy, configurationFingerprint(config));
  assert.equal(fingerprintForRun(config, legacy), legacy);
  assert.notEqual(fingerprintForRun(longer, legacy), legacy);
  assert.equal(fingerprintForRun(longer, configurationFingerprint(config)), configurationFingerprint(config));
  assert.equal(fingerprintForRun(config, undefined), configurationFingerprint(config));
});

test('the most specific selection rule decides; duplicate rules are rejected', () => {
  const verification = [{ executable: 'tsc' }, { executable: 'fast' }, { executable: 'slow' }];
  const selection = { rules: [{ path: 'src', commands: [0, 1] }, { path: 'src/factory-cli.ts', commands: [0, 1, 2] }, { path: 'docs', commands: [0] }], dependencyPaths: ['package.json'], dependenciesComprehensive: true };
  validateSelectionConfig(selection, verification);
  const select = (...paths: string[]) => selectVerification(verification, selection, { suitable: true, reasons: [], changes: paths.map(path => ({ path, status: 'M' as const, source: 'unstaged' as const })) });
  assert.deepEqual(select('src/dashboard-reader.ts').commands.map(command => command.executable), ['tsc', 'fast']);
  assert.deepEqual(select('src/factory-cli.ts').commands.map(command => command.executable), ['tsc', 'fast', 'slow']);
  assert.deepEqual(select('docs/guide.md').commands.map(command => command.executable), ['tsc']);
  assert.deepEqual(select('docs/guide.md', 'src/factory-cli.ts').commands.map(command => command.executable), ['tsc', 'fast', 'slow']);
  assert.equal(select('src/factory-cli.tsx').mode, 'selected', 'a prefix matches whole path segments only');
  assert.deepEqual(select('src/factory-cli.tsx').commands.map(command => command.executable), ['tsc', 'fast']);
  assert.equal(select('unmapped.txt').mode, 'full');
  assert.equal(select('package.json').mode, 'full');
  assert.throws(() => validateSelectionConfig({ ...selection, rules: [...selection.rules, { path: 'src', commands: [0] }] }, verification), /duplicate path rules/);
});
