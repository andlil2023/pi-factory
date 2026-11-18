import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FactoryRunState } from '../../src/state-store.ts';
import { assertSubprocessStarted, subprocessDiagnostics } from '../subprocess-diagnostics.ts';

const cli = resolve('src/factory-cli.ts');
test('CLI reviews a new plan, then replans a too-large task and completes the run without an operator', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-auto-replan-cli-'));
  const repository = join(dir, 'project');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.autocrlf', 'false');
  await writeFile(join(repository, '.gitignore'), '.factory/\n');
  git('add', '.'); git('commit', '-m', 'initial');
  const model = { provider: 'fixture', model: 'fixture' };
  const writeConfig = async (name: string, execution: object) => {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify({ agents: { planner: model, implementer: model, reviewer: model }, execution, verification: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
      pi: { executable: process.execPath, executableArgs: [resolve('tests/fixtures/fake-auto-replan-agent.mjs')] } }));
    return path;
  };
  const runCli = (config: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args, '--config', config], { encoding: 'utf8', timeout: 300_000 });
    assert.doesNotThrow(() => assertSubprocessStarted(result), subprocessDiagnostics(result));
    return result;
  };
  const config = await writeConfig('config.json', { maxAttempts: 3 });

  const objective = join(dir, 'objective.md');
  await writeFile(objective, 'Write fixture files.');
  const planPath = join(dir, 'plan.json');
  const planned = runCli(config, 'plan', '--repo', repository, '--objective', objective, '--output', planPath);
  assert.equal(planned.status, 0, subprocessDiagnostics(planned));
  assert.match(planned.stdout, /Plan review approved it after 2 review\(s\)/);
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as { tasks: Array<{ acceptanceCriteria: string[] }>; decisions: unknown[] };
  assert.deepEqual(plan.tasks.map(task => task.acceptanceCriteria[0]), ['Fixture file exists', 'Fixture file exists'], 'the reviewed revision is saved');
  assert.deepEqual(plan.decisions, []);
  const reviews = JSON.parse(await readFile(join(dir, 'plan.review.json'), 'utf8')) as Array<{ verdict: string }>;
  assert.deepEqual(reviews.map(review => review.verdict), ['changes_requested', 'approved']);

  // With the budget at zero the same blocker stops for the operator, as before.
  const stopped = runCli(await writeConfig('manual.json', { maxAttempts: 3, maxAutoReplans: 0 }), 'run', '--repo', repository, '--plan', planPath, '--approve');
  assert.equal(stopped.status, 1, subprocessDiagnostics(stopped));
  assert.doesNotMatch(stopped.stdout, /Automatic replan/);
  const directory = join(repository, '.factory', 'runs');
  const manualRun = (await readdir(directory)).find(file => /^run-[^.]+\.json$/.test(file))!;
  assert.equal((JSON.parse(await readFile(join(directory, manualRun), 'utf8')) as FactoryRunState).status, 'blocked');

  const run = runCli(config, 'run', '--repo', repository, '--plan', planPath, '--approve');
  assert.equal(run.status, 0, subprocessDiagnostics(run));
  assert.match(run.stdout, /Automatic replan 1: T002 \(task_too_large\) superseded; added T003, T004/);
  const statePath = join(directory, (await readdir(directory)).find(file => /^run-[^.]+\.json$/.test(file) && file !== manualRun)!);
  const state = JSON.parse(await readFile(statePath, 'utf8')) as FactoryRunState;
  assert.equal(state.status, 'completed');
  assert.deepEqual(Object.entries(state.tasks).map(([id, task]) => `${id}:${task.status}`), ['T001:completed', 'T003:completed', 'T004:completed']);
  assert.deepEqual(state.supersededTasks?.map(entry => entry.task.id), ['T002']);
  assert.equal(state.planRevisions?.length, 1);
  assert.equal(state.autoReplans?.length, 1);
  // No task selection is configured, so the last task ran every trusted command on the tree it committed: final verification reuses it.
  const final = state.finalVerification as { passed: boolean; details: { reused?: { from: string; taskId: string } } };
  assert.deepEqual([final.passed, final.details.reused?.from, final.details.reused?.taskId], [true, 'task verification', 'T004']);
  const record = state.autoReplans![0];
  assert.deepEqual([record.taskId, record.reason, record.superseded, record.added], ['T002', 'task_too_large', ['T002'], ['T003', 'T004']]);
  assert.match(await readFile(record.leftoverPatch!, 'utf8'), /PARTIAL_WORK_OF_T002/);
  assert.match(await readFile(statePath.replace(/\.json$/, '.events.jsonl'), 'utf8'), /PLAN_REVISED/);
  // The source checkout is untouched: work exists only on the run branch.
  assert.equal(git('status', '--porcelain'), '');
});
