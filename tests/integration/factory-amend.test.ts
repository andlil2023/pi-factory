import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FactoryRunState } from '../../src/state-store.ts';
import { assertSubprocessStarted, subprocessDiagnostics } from '../subprocess-diagnostics.ts';

const cli = resolve('src/factory-cli.ts');
test('CLI replans a too-large task, amends the stopped run with approval, and completes it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-amend-cli-'));
  const repository = join(dir, 'project');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  await writeFile(join(repository, '.gitignore'), '.factory/\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  const task = (id: string, dependencies: string[], acceptanceCriteria = ['Fixture file exists']) => ({ id, title: `Task ${id}`, objective: 'Write a fixture file', scope: `${id}.txt`, acceptanceCriteria, dependencies, verification: ['trusted-check'] });
  const planFile = async (name: string, tasks: unknown[]) => {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify({ objective: 'Fixture', assumptions: [], decisions: [], tasks, verification: ['trusted-check'] }));
    return path;
  };
  const config = join(dir, 'config.json');
  const model = { provider: 'fixture', model: 'fixture' };
  await writeFile(config, JSON.stringify({ agents: { planner: model, implementer: model, reviewer: model }, execution: { maxAttempts: 3, maxAutoReplans: 0 }, planning: { maxReviewRounds: 0 }, verification: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'] }], pi: { executable: process.execPath, executableArgs: [resolve('tests/fixtures/fake-replan-agent.mjs')] } }));
  // Measured run/resume took 55.5/58.0 seconds in the full suite versus
  // 5.3/16.1 seconds isolated. Allow roughly twice that observed suite time.
  const runCli = (...args: string[]) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args, '--config', config], { encoding: 'utf8', timeout: 120_000 });
    const diagnostic = `command: ${args[0]}; elapsed ms: ${Date.now() - started}\n${subprocessDiagnostics(result)}`;
    assert.doesNotThrow(() => assertSubprocessStarted(result), diagnostic);
    return result;
  };
  const directory = join(repository, '.factory', 'runs');

  const oversized = runCli('run', '--repo', repository, '--plan', await planFile('oversized.json', [task('T001', [], Array.from({ length: 6 }, (_, index) => `Criterion ${index}`))]), '--approve');
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /acceptance criteria/);
  await assert.rejects(readdir(directory), 'An oversized plan must not start a run');

  const first = runCli('run', '--repo', repository, '--plan', await planFile('plan.json', [task('T001', []), task('T002', ['T001'])]), '--approve');
  assert.equal(first.status, 1, subprocessDiagnostics(first));
  const statePath = join(directory, (await readdir(directory)).find(file => file.endsWith('.json'))!);
  const load = async () => JSON.parse(await readFile(statePath, 'utf8')) as FactoryRunState;
  const blocked = await load();
  assert.equal(blocked.tasks.T002.status, 'blocked');
  assert.match(blocked.tasks.T002.lastError!, /^task_too_large: /);
  assert.match(first.stdout, /replan/, 'Status output should point to the replan path');

  const guidance = join(dir, 'guidance.txt');
  await writeFile(guidance, 'Split by file.');
  const revised = join(dir, 'revised.json');
  const replanned = runCli('replan', '--repo', repository, '--run', blocked.runId, '--output', revised, '--guidance', guidance);
  assert.equal(replanned.status, 0, subprocessDiagnostics(replanned));
  assert.deepEqual(await load(), blocked, 'Replanning must not change run state');

  const unapproved = runCli('amend', '--repo', repository, '--run', blocked.runId, '--plan', revised);
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /requires --approve/);
  const amended = runCli('amend', '--repo', repository, '--run', blocked.runId, '--plan', revised, '--approve');
  assert.equal(amended.status, 0, subprocessDiagnostics(amended));
  const paused = await load();
  assert.deepEqual(Object.keys(paused.tasks), ['T001', 'T003', 'T004']);
  assert.equal(paused.supersededTasks![0].task.id, 'T002');
  assert.equal(paused.supersededTasks![0].task.attempts[0].outcome, 'blocked');
  assert.equal(paused.planRevisions!.length, 1);
  assert.equal(paused.tasks.T001.checkpointCommit, blocked.tasks.T001.checkpointCommit);

  const resumed = runCli('resume', '--repo', repository, '--run', blocked.runId, '--approve');
  assert.equal(resumed.status, 0, subprocessDiagnostics(resumed));
  const completed = await load();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.tasks.T001.attempts.length, 1, 'Accepted work is not replayed');
  assert.equal(await readFile(join(completed.git!.worktree, 'T004.txt'), 'utf8'), 'Task T004');
});
