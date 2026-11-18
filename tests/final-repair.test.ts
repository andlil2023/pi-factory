import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.ts';
import { FactoryEventBus, type FactoryEvent } from '../src/event-bus.ts';
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
    finalVerify: async () => ++finals === 1 ? failedFinal : { passed: true, details: {} }
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

test('a final failure that does not reproduce withdraws the repair task instead of blocking on an empty commit', async t => {
  const { store, state, tasks } = await fixture(t);
  let finals = 0, reviews = 0, checkpoints = 0;
  const result = await new Orchestrator(store, {
    implement: async () => ({ outcome: 'implemented', report: {} }),
    verify: async () => ({ passed: true, details: {} }),
    review: async () => { reviews++; return [{ reviewer: 'code', verdict: 'approved', report: {} }]; },
    checkpoint: async () => ({ commit: `commit-${++checkpoints}` }),
    // The transient failure left nothing to change.
    hasChanges: async context => context.task.id !== 'T003',
    finalVerify: async () => ++finals === 1 ? failedFinal : { passed: true, details: {} }
  }, { maxFinalRepairs: 2 }).execute(state, tasks);
  assert.equal(result.status, 'completed');
  assert.equal(finals, 2);
  assert.deepEqual([reviews, checkpoints], [2, 2], 'nothing to review or commit for the withdrawn repair');
  const saved = await store.load(state.runId);
  assert.deepEqual(Object.keys(saved.tasks), ['T001', 'T002']);
  assert.deepEqual((saved.plan as { tasks: PlannedTask[] }).tasks.map(item => item.id), ['T001', 'T002']);
  assert.deepEqual(tasks.map(item => item.id), ['T001', 'T002']);
  assert.equal(saved.finalRepairs![0].withdrawn, true);
  assert.deepEqual(saved.supersededTasks?.map(entry => entry.task.id), ['T003'], 'the attempt history is kept and the ID is retired');
});

test('a pending integration repair receives feedback and uses full verification', async t => {
  const { store, state, tasks } = await fixture(t);
  state.tasks.T001.status = 'completed';
  state.tasks.T002.status = 'completed';
  const repair = task('T003', ['T001', 'T002']);
  tasks.push(repair);
  (state.plan as { tasks: PlannedTask[] }).tasks.push(structuredClone(repair));
  state.tasks.T003 = { id: 'T003', status: 'pending', attempts: [] };
  state.integrations = [{ number: 1, status: 'blocked', approvedAt: 'now', worktree: 'worktree', branch: 'candidate', targetBranch: 'main', targetHead: 'target', sourceHead: 'source', verification: failedFinal }];
  state.integrationRepairs = [{ at: 'now', taskId: 'T003', integrationAttempt: 1 }];
  let seen: TaskContext | undefined;
  const result = await new Orchestrator(store, {
    implement: async context => { seen = context; return { outcome: 'implemented', report: {} }; },
    verify: async context => { assert.equal(context.fullVerification, true); return { passed: true, details: {} }; },
    review: async () => [{ reviewer: 'code', verdict: 'approved', report: {} }],
    finalVerify: async () => ({ passed: true, details: {} })
  }).execute(state, tasks);
  assert.equal(result.status, 'completed');
  assert.equal(seen?.attempt, 1);
  assert.equal(seen?.feedback?.open.reason, 'Integration candidate rejected');
  assert.equal(seen?.feedback?.open.failedChecks[0].logFile, '/logs/FINAL-1-1.log');
  assert.match(seen!.feedback!.notes[0], /merged result/);
  assert.equal(result.tasks.T003.status, 'completed');
});

test('integration repair keeps rejection feedback after a retryable timeout and does not withdraw failed verification', async t => {
  const { store, state, tasks } = await fixture(t);
  state.tasks.T001.status = 'completed';
  state.tasks.T002.status = 'completed';
  tasks.push(task('T003', ['T001', 'T002']));
  (state.plan as { tasks: PlannedTask[] }).tasks.push(structuredClone(tasks[2]));
  state.tasks.T003 = { id: 'T003', status: 'pending', attempts: [] };
  state.execution = { maxAttempts: 1, maxInfraRetries: 1, configurationFingerprint: 'test' };
  state.integrations = [{ number: 1, status: 'blocked', approvedAt: 'now', worktree: 'worktree', branch: 'candidate', targetBranch: 'main', targetHead: 'target', sourceHead: 'source', verification: failedFinal }];
  state.integrationRepairs = [{ at: 'now', taskId: 'T003', integrationAttempt: 1 }];
  const { AgentExecutionError } = await import('../src/agent-error.ts');
  let changesChecked = false;
  const result = await new Orchestrator(store, {
    implement: async context => {
      assert.equal(context.feedback?.open.failedChecks[0].logFile, '/logs/FINAL-1-1.log');
      if (context.attempt === 1) throw new AgentExecutionError('implementer', true, 'PI timed out');
      assert.ok(context.feedback?.notes.some(note => /timed out/.test(note)));
      return { outcome: 'implemented', report: {} };
    },
    verify: async () => ({ passed: false, details: {} }),
    hasChanges: async () => { changesChecked = true; return false; },
    review: async () => { assert.fail('failed verification must not be reviewed'); }
  }, { maxAttempts: 1 }).execute(state, tasks);
  assert.equal(result.status, 'blocked');
  assert.equal(changesChecked, false);
  assert.equal(result.integrationRepairs?.[0].withdrawn, undefined);
  assert.equal(result.tasks.T003.attempts.length, 2);
});

test('an unchanged passing integration repair is withdrawn and recorded', async t => {
  const { store, state } = await fixture(t);
  state.tasks.T001.status = 'completed';
  state.tasks.T002.status = 'completed';
  const tasks = (state.plan as { tasks: PlannedTask[] }).tasks;
  tasks.push(task('T003', ['T001', 'T002']));
  state.tasks.T003 = { id: 'T003', status: 'pending', attempts: [] };
  state.integrations = [{ number: 1, status: 'blocked', approvedAt: 'now', worktree: 'worktree', branch: 'candidate', targetBranch: 'main', targetHead: 'target', sourceHead: 'source', verification: failedFinal }];
  state.integrationRepairs = [{ at: 'now', taskId: 'T003', integrationAttempt: 1 }];
  const events: Readonly<FactoryEvent>[] = [];
  const bus = new FactoryEventBus({ runId: state.runId, consoleOutput: false });
  bus.subscribe(event => events.push(event));
  const result = await new Orchestrator(store, {
    implement: async () => ({ outcome: 'implemented', report: {} }),
    verify: async context => { assert.equal(context.fullVerification, true); return { passed: true, details: {} }; },
    hasChanges: async () => false,
    review: async () => { assert.fail('withdrawn repair must not be reviewed'); },
    checkpoint: async () => { assert.fail('withdrawn repair must not be checkpointed'); },
    finalVerify: async () => ({ passed: true, details: {} })
  }, { events: bus }).execute(state, tasks);
  assert.equal(result.status, 'completed');
  const saved = await store.load(state.runId);
  assert.equal(saved.integrationRepairs?.[0].withdrawn, true);
  assert.deepEqual(Object.keys(saved.tasks), ['T001', 'T002']);
  assert.deepEqual((saved.plan as { tasks: PlannedTask[] }).tasks.map(item => item.id), ['T001', 'T002']);
  assert.deepEqual(saved.supersededTasks?.map(entry => entry.task.id), ['T003']);
  assert.equal(saved.supersededTasks?.[0].task.attempts.length, 1);
  assert.equal((saved.planRevisions?.[0].plan as { tasks: PlannedTask[] }).tasks.length, 3);
  assert.ok(events.some(event => event.type === 'PLAN_REVISED' && event.taskId === 'T003'));
});

test('a repair attempt that only timed out does not hide the failed final checks', async t => {
  const { store, state, tasks } = await fixture(t);
  state.execution = { maxAttempts: 3, maxInfraRetries: 1, configurationFingerprint: 'test' };
  const seen: Array<{ attempt: number; failures: string[]; notes: string[] }> = [];
  let finals = 0;
  const { AgentExecutionError } = await import('../src/agent-error.ts');
  await new Orchestrator(store, {
    implement: async context => {
      if (context.task.id === 'T003') {
        seen.push({ attempt: context.attempt, failures: context.feedback!.open.failedChecks.flatMap(check => check.failures), notes: context.feedback!.notes });
        if (context.attempt === 1) throw new AgentExecutionError('implementer', true, 'PI timed out after 600000 ms');
      }
      return { outcome: 'implemented', report: {} };
    },
    verify: async () => ({ passed: true, details: {} }),
    review: async () => [{ reviewer: 'code', verdict: 'approved', report: {} }],
    finalVerify: async () => ++finals === 1 ? failedFinal : { passed: true, details: {} }
  }, { maxFinalRepairs: 1 }).execute(state, tasks);
  assert.deepEqual(seen.map(entry => entry.attempt), [1, 2]);
  assert.deepEqual(seen[1].failures, ['not ok 4 - combined behavior breaks']);
  assert.ok(seen[1].notes.some(note => /session time limit/.test(note)));
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
