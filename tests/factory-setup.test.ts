import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FactoryRunState } from '../src/state-store.ts';
import { assertSubprocessStarted, subprocessDiagnostics } from './subprocess-diagnostics.ts';

const cli = resolve('src/factory-cli.ts');
const node = (script: string) => ({ executable: process.execPath, args: ['-e', script] });
async function fixture(t: import('node:test').TestContext, setup: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-setup-cli-'));
  const repository = join(dir, 'project');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  // Like node_modules: produced by setup, ignored by Git, required by verification.
  await writeFile(join(repository, '.gitignore'), '.factory/\ninstalled.txt\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  const plan = join(dir, 'plan.json');
  await writeFile(plan, JSON.stringify({ objective: 'Fixture', assumptions: [], decisions: [], verification: ['trusted-check'],
    tasks: [{ id: 'T001', title: 'Task T001', objective: 'Write a fixture file', scope: 'T001.txt', acceptanceCriteria: ['Fixture file exists'], dependencies: [], verification: ['trusted-check'] }] }));
  const config = join(dir, 'config.json');
  const model = { provider: 'fixture', model: 'fixture' };
  await writeFile(config, JSON.stringify({ agents: { planner: model, implementer: model, reviewer: model }, execution: { maxAttempts: 3 }, setup,
    verification: [node("process.exit(require('fs').existsSync('installed.txt')?0:1)")],
    pi: { executable: process.execPath, executableArgs: [resolve('tests/fixtures/fake-replan-agent.mjs')] } }));
  const runCli = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args, '--config', config], { encoding: 'utf8', timeout: 180_000 });
    assertSubprocessStarted(result);
    return result;
  };
  const runs = join(repository, '.factory', 'runs');
  return { repository, plan, runCli, runs };
}

test('setup commands prepare the run worktree and each integration worktree before verification', async t => {
  const { repository, plan, runCli, runs } = await fixture(t, [node("require('fs').writeFileSync('installed.txt','ok')")]);
  const run = runCli('run', '--repo', repository, '--plan', plan, '--approve');
  assert.equal(run.status, 0, subprocessDiagnostics(run));
  const statePath = join(runs, (await readdir(runs)).find(file => file.endsWith('.json'))!);
  const completed = JSON.parse(await readFile(statePath, 'utf8')) as FactoryRunState;
  assert.equal(completed.status, 'completed');
  const guidancePath = join(repository, '.factory', 'integration-guidance.txt');
  await writeFile(guidancePath, 'Approved evidence location: C:/evidence/report.json');
  const invalid = runCli('integrate', '--repo', repository, '--run', completed.runId, '--approve', '--publish', '--candidate', 'unused', '--guidance', guidancePath);
  assert.equal(invalid.status, 1, subprocessDiagnostics(invalid));
  assert.match(invalid.stderr, /--guidance is only valid/);
  const prepared = runCli('integrate', '--repo', repository, '--run', completed.runId, '--approve', '--guidance', guidancePath);
  assert.equal(prepared.status, 0, subprocessDiagnostics(prepared));
  const integration = (JSON.parse(await readFile(statePath, 'utf8')) as FactoryRunState).integrations!.at(-1)!;
  assert.equal(integration.status, 'ready');
  assert.equal(integration.guidance, 'Approved evidence location: C:/evidence/report.json');
  assert.equal(await readFile(join(integration.worktree, 'installed.txt'), 'utf8'), 'ok');
});

test('a failing setup command stops before any agent runs and names the command', async t => {
  const { repository, plan, runCli, runs } = await fixture(t, [node('process.exit(3)')]);
  const run = runCli('run', '--repo', repository, '--plan', plan, '--approve');
  assert.equal(run.status, 1, subprocessDiagnostics(run));
  assert.match(run.stderr, /Setup command failed/);
  await assert.rejects(readdir(runs), 'No run state may exist when setup failed');
});

test('rejects a malformed setup configuration', async t => {
  const { repository, plan, runCli } = await fixture(t, [{ args: ['ci'] }]);
  const run = runCli('run', '--repo', repository, '--plan', plan, '--approve');
  assert.equal(run.status, 1, subprocessDiagnostics(run));
  assert.match(run.stderr, /Invalid setup/);
});
