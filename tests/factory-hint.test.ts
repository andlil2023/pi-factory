import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('src/factory-cli.ts');
test('an exhausted retry budget is not answered with a resume hint that the factory rejects', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-hint-cli-'));
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
  const plan = join(dir, 'plan.json');
  await writeFile(plan, JSON.stringify({ objective: 'Fixture', assumptions: [], decisions: [], verification: ['trusted-check'],
    tasks: [{ id: 'T001', title: 'Task T001', objective: 'Write a fixture file', scope: 'T001.txt', acceptanceCriteria: ['Fixture file exists'], dependencies: [], verification: ['trusted-check'] }] }));
  const config = join(dir, 'config.json');
  const model = { provider: 'fixture', model: 'fixture' };
  // Verification always fails, so the single budgeted attempt is rejected.
  await writeFile(config, JSON.stringify({ agents: { planner: model, implementer: model, reviewer: model }, execution: { maxAttempts: 1 },
    verification: [{ executable: process.execPath, args: ['-e', 'process.exit(1)'] }],
    pi: { executable: process.execPath, executableArgs: [resolve('tests/fixtures/fake-replan-agent.mjs')] } }));
  const runCli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args, '--config', config], { encoding: 'utf8', timeout: 180_000 });

  const run = runCli('run', '--repo', repository, '--plan', plan, '--approve');
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /Maximum attempts \(1\) exhausted/);
  const runId = (await readdir(join(repository, '.factory', 'runs'))).find(file => file.endsWith('.json'))!.slice(0, -5);
  const status = runCli('status', '--repo', repository, '--run', runId);
  for (const output of [run.stdout, status.stdout]) {
    assert.match(output, /T001: retry budget exhausted; resume cannot retry it\./);
    assert.match(output, /replan/);
    assert.doesNotMatch(output, /resume --retry-task/);
  }
  // The premise of the hint: the factory refuses to retry this task.
  const resume = runCli('resume', '--repo', repository, '--run', runId, '--retry-task', 'T001', '--approve');
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /budget exhausted/);
});
