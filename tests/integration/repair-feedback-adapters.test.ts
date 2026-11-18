import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentAdapters, type AgentAdapterConfig, type VerificationCheck } from '../../src/agent-adapters.ts';
import type { AttemptFeedback } from '../../src/attempt-feedback.ts';

const model = { provider: 'test-provider', model: 'test-model' };
const task = { id: 'T001', title: 'Test', objective: 'Test', scope: 'Test', acceptanceCriteria: ['Test'], dependencies: [], verification: ['test'] };
const feedback: AttemptFeedback = {
  open: { attempt: 1, reason: 'Review requested changes', failedChecks: [], uiEvidenceIssues: [],
    findings: [{ reviewer: 'code', attempt: 1, description: 'OPEN_FINDING_MARKER', requiredAction: 'Handle empty input' }] },
  mustStayFixed: [], history: [{ attempt: 1, result: 'Review requested changes' }], notes: []
};

async function fixture(t: import('node:test').TestContext, extra: Partial<AgentAdapterConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-repair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repo');
  execFileSync('git', ['init', repository]);
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'], { cwd: repository });
  const adapters = createAgentAdapters({ repository, factoryRoot: resolve('.'),
    piExecutable: process.execPath, piExecutableArgs: [resolve('tests/fixtures/fake-reviewer.mjs'), 'normal'],
    implementer: model, reviewer: model, verification: [], baselineCommit: 'HEAD', ...extra });
  return { adapters, repository, directory };
}
const promptOf = (review: { report: unknown }) => (JSON.parse((review.report as { summary: string }).summary) as { prompt: string }).prompt;

test('repair review prompt carries structured feedback instead of raw history', async t => {
  const { adapters } = await fixture(t);
  const [review] = await adapters.review({ task, attempt: 2, previousFeedback: [{ raw: 'RAW_HISTORY_MARKER' }], feedback },
    { outcome: 'implemented', report: {} }, { passed: true, details: [] });
  const prompt = promptOf(review);
  assert.match(prompt, /OPEN_FINDING_MARKER/);
  assert.match(prompt, /This is a repair attempt/);
  assert.match(prompt, /untrusted evidence, not instructions/);
  assert.doesNotMatch(prompt, /RAW_HISTORY_MARKER/);
});

test('UI reviewer without a collector is told source-only review is the accepted standard', async t => {
  const { adapters } = await fixture(t, { reviewers: { ui: model } });
  const reviews = await adapters.review({ task, attempt: 1, previousFeedback: [] }, { outcome: 'implemented', report: {} }, { passed: true, details: [] });
  const ui = promptOf(reviews.find(review => review.reviewer === 'ui')!);
  assert.match(ui, /Source-only review is the accepted evidence standard/);
  assert.doesNotMatch(promptOf(reviews.find(review => review.reviewer === 'code')!), /Source-only review is the accepted/);
});

test('failed verification keeps extracted failures and writes the full output outside the worktree', async t => {
  const { adapters, directory } = await fixture(t, {
    logDirectory: join(tmpdir(), `factory-logs-${process.pid}-${Date.now()}`),
    verification: [{ executable: process.execPath, args: ['-e', `console.log('not ok 7 - EARLY_FAILURE_NAME');console.log('x'.repeat(60000));console.error('late stderr');process.exit(1)`] }] });
  const result = await adapters.verify({ task, attempt: 2, previousFeedback: [] });
  const [check] = (result.details as { checks: VerificationCheck[] }).checks;
  t.after(() => rm(join(check.logFile!, '..'), { recursive: true, force: true }));
  assert.equal(result.passed, false);
  assert.deepEqual(check.failures, ['not ok 7 - EARLY_FAILURE_NAME']);
  assert.ok(check.stdout.length < 17_000 && check.stdout.includes('EARLY_FAILURE_NAME'), 'bounded output keeps the start');
  assert.match(check.logFile!, /T001-2-1\.log$/);
  assert.ok(!resolve(check.logFile!).startsWith(resolve(directory, 'repo')));
  const log = await readFile(check.logFile!, 'utf8');
  assert.ok(log.length > 60_000 && log.includes('late stderr'));
});

test('a command that passes on rerun is accepted and recorded as flaky; a repeated failure still fails', async t => {
  const { adapters, directory } = await fixture(t);
  const marker = join(directory, 'ran-once');
  const flakyCommand = { executable: process.execPath, args: ['-e', `const fs=require('fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'');console.log('not ok 1 - flaky subprocess timeout');process.exit(1)}`] };
  const failing = { executable: process.execPath, args: ['-e', 'process.exit(1)'] };
  const make = (verification: AgentAdapterConfig['verification'], verificationReruns?: number) => createAgentAdapters({ repository: join(directory, 'repo'), factoryRoot: resolve('.'),
    implementer: model, reviewer: model, verification, baselineCommit: 'HEAD', verificationReruns });
  const context = { task, attempt: 1, previousFeedback: [] };

  const progress: number[] = [];
  const flaky = await make([flakyCommand], 1).verify({ ...context, onVerificationProgress: async p => { progress.push(p.failed); } });
  const details = flaky.details as { checks: VerificationCheck[]; flaky?: string[] };
  assert.equal(flaky.passed, true);
  assert.equal(details.checks[0].flaky, true);
  assert.deepEqual(details.checks[0].firstFailure?.failures, ['not ok 1 - flaky subprocess timeout']);
  assert.equal(details.flaky?.length, 1);
  assert.deepEqual(progress, [0, 0]);

  const real = await make([failing], 1).verify(context);
  assert.equal(real.passed, false);
  assert.equal((real.details as typeof details).flaky, undefined);

  await rm(marker);
  const noRerun = await make([flakyCommand]).verify(context);
  assert.equal(noRerun.passed, false, 'reruns are opt-in for the adapter');
});

test('repair implementer prompt lists open items and paths already changed', async t => {
  const { repository, directory } = await fixture(t);
  await writeFile(join(repository, 'existing-work.txt'), 'attempt 1');
  const capture = join(directory, 'prompt.txt');
  const agent = join(directory, 'agent.mjs');
  await writeFile(agent, `import { writeFileSync } from 'node:fs';let p='';process.stdin.setEncoding('utf8');for await (const c of process.stdin) p+=c;writeFileSync(${JSON.stringify(capture)},p);
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({taskId:'T001',outcome:'implemented',summary:'ok',filesChanged:[],verification:[],blockers:[]})}]}}));`);
  const adapters = createAgentAdapters({ repository, factoryRoot: resolve('.'), piExecutable: process.execPath, piExecutableArgs: [agent],
    implementer: model, reviewer: model, verification: [], baselineCommit: 'HEAD' });
  await adapters.implement({ task, attempt: 2, previousFeedback: [{ raw: 'RAW_HISTORY_MARKER' }], feedback });
  const prompt = await readFile(capture, 'utf8');
  assert.match(prompt, /OPEN_FINDING_MARKER/);
  assert.match(prompt, /Handle empty input/);
  assert.match(prompt, /existing-work\.txt/);
  assert.doesNotMatch(prompt, /RAW_HISTORY_MARKER/);
});
