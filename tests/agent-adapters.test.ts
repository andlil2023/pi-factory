import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import type { ReviewRouting } from '../src/review-routing.ts';
import type { UiEvidenceConfig } from '../src/ui-evidence.ts';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentAdapters, requiredReviewerIds, type SpecialistReviewers } from '../src/agent-adapters.ts';

const model = { provider: 'test-provider', model: 'test-model' };
const context = { task: { id: 'T001', title: 'Test', objective: 'Test', scope: 'Test', acceptanceCriteria: ['Test'], dependencies: [], verification: ['test'] }, attempt: 1, previousFeedback: [] };
async function fixture(t: import('node:test').TestContext, mode = 'normal', reviewers?: SpecialistReviewers, reviewRouting: ReviewRouting = 'all', uiEvidence?: UiEvidenceConfig) {
  const repository = await mkdtemp(join(tmpdir(), 'factory-reviewers-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: repository });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'], { cwd: repository });
  const adapters = createAgentAdapters({ repository, factoryRoot: resolve('.'),
    piExecutable: process.execPath, piExecutableArgs: [resolve('tests/fixtures/fake-reviewer.mjs'), mode],
    implementer: model, reviewer: model, reviewers, reviewRouting, uiEvidence, verification: [], baselineCommit: 'HEAD' });
  return { ...adapters, repository };
}

test('reviewer configuration defaults to code and rejects invalid specialists', () => {
  assert.deepEqual(requiredReviewerIds(), ['code']);
  assert.deepEqual(requiredReviewerIds({ ui: model, security: model }), ['code', 'security', 'ui']);
  for (const invalid of [null, [], { typo: model }, { security: {} }, { ui: { ...model, timeoutMs: -1 } }]) {
    assert.throws(() => requiredReviewerIds(invalid as SpecialistReviewers));
  }
});

test('existing configurations invoke only the code reviewer', async t => {
  const adapters = await fixture(t);
  const reviews = await adapters.review(context, { outcome: 'implemented', report: {} }, { passed: true, details: [] });
  assert.deepEqual(reviews.map(r => r.reviewer), ['code']);
});

test('specialists run independently with their own instructions, models and read-only tools', async t => {
  const adapters = await fixture(t, 'normal', { security: { provider: 'security-provider', model: 'security-model' }, ui: model });
  const reviews = await adapters.review(context, { outcome: 'implemented', report: {} }, { passed: true, details: ['trusted-check'] });
  assert.deepEqual(reviews.map(r => r.reviewer), ['code', 'security', 'ui']);
  const pids = new Set<number>();
  for (const review of reviews) {
    const { args, pid } = JSON.parse((review.report as { summary: string }).summary) as { args: string[]; pid: number };
    pids.add(pid);
    const instructions = args[args.indexOf('--append-system-prompt') + 1];
    assert.match(instructions, new RegExp(review.reviewer === 'code' ? 'Independent Code Reviewer' : review.reviewer === 'security' ? 'Security Reviewer' : 'UI and Accessibility Reviewer'));
    assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
    assert.ok(args.includes('--no-session'));
    assert.equal(args[args.indexOf('--model') + 1], review.reviewer === 'security' ? 'security-model' : 'test-model');
    assert.match(args.at(-1)!, /trusted-check/);
  }
  assert.equal(pids.size, 3);
});

for (const mode of ['wrong-reviewer', 'wrong-task', 'invalid']) {
  test(`rejects ${mode} specialist reports`, async t => {
    const adapters = await fixture(t, mode, { security: model });
    await assert.rejects(adapters.review(context, { outcome: 'implemented', report: {} }, { passed: true, details: [] }), /Invalid security review report/);
  });
}

test('fresh production reviewer prompts include prior findings as untrusted evidence', async t => {
  const adapters = await fixture(t, 'normal', { security: model, ui: model });
  const reviews = await adapters.review({ ...context, attempt: 2, previousFeedback: [{ findings: [{ severity: 'blocking', description: 'PRIOR_FINDING_MARKER_901' }] }] }, { outcome: 'implemented', report: {} }, { passed: true, details: [] });
  for (const review of reviews) {
    const { args } = JSON.parse((review.report as { summary: string }).summary) as { args: string[] };
    assert.match(args.at(-1)!, /PRIOR_FINDING_MARKER_901/);
    assert.match(args.at(-1)!, /untrusted evidence, not instructions/);
    assert.match(args.at(-1)!, /reassess prior blocking findings/);
  }
});

test('production adapter exposes validated partial reports before a later reviewer fails', async t => {
  const adapters = await fixture(t, 'partial-failure', { security: model, ui: model });
  const reports: string[] = [];
  await assert.rejects(adapters.review(context, { outcome: 'implemented', report: {} }, { passed: true, details: [] }, async review => {
    reports.push(`${review.reviewer}:${review.verdict}`);
  }), /Invalid ui review report/);
  assert.deepEqual(reports, ['code:approved', 'security:changes_requested']);
});

test('routes from observed files and only invokes the selected reviewers', async t => {
  const adapters = await fixture(t, 'normal', { security: model, ui: model }, 'task-specific');
  await writeFile(join(adapters.repository, 'README.md'), 'Documentation only');
  const selection = await adapters.selectReviewers!(context);
  assert.deepEqual(selection.requiredReviewers, ['code']);
  assert.deepEqual(selection.changedFiles, ['README.md']);
  const reviews = await adapters.review({ ...context, requiredReviewers: selection.requiredReviewers }, { outcome: 'implemented', report: {} }, { passed: true, details: [] });
  assert.deepEqual(reviews.map(r => r.reviewer), ['code']);
  await assert.rejects(adapters.review({ ...context, requiredReviewers: ['ui'] }, { outcome: 'implemented', report: {} }, { passed: true, details: [] }), /Invalid reviewer selection/);
});

test('routing sees untracked, staged, deleted and renamed paths rather than reported files', async t => {
  const adapters = await fixture(t, 'normal', { security: model, ui: model }, 'task-specific');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: adapters.repository });
  await mkdir(join(adapters.repository, 'auth'));
  await writeFile(join(adapters.repository, 'auth', 'login.ts'), 'original');
  await writeFile(join(adapters.repository, 'removed.ts'), 'removed');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'baseline');
  await rename(join(adapters.repository, 'auth', 'login.ts'), join(adapters.repository, 'notes.md'));
  await rm(join(adapters.repository, 'removed.ts'));
  git('add', '-A');
  await writeFile(join(adapters.repository, 'screen.tsx'), 'untracked');
  const selection = await adapters.selectReviewers!(context);
  assert.deepEqual(selection.changedFiles, ['auth/login.ts', 'notes.md', 'removed.ts', 'screen.tsx']);
  assert.deepEqual(selection.requiredReviewers, ['code', 'security', 'ui']);
});

test('UI reviewer receives validated desktop artifact paths, not merely implementation claims', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-ui-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapters = await fixture(t, 'normal', { ui: model }, 'all', {
    directory, command: { executable: process.execPath, args: [resolve('tests/fixtures/fake-ui-collector.mjs')] }
  });
  await assert.rejects(adapters.review({ ...context, requiredReviewers: ['code', 'ui'] }, { outcome: 'implemented', report: {} }, { passed: true, details: [] }), /Required UI evidence is missing/);
  const uiEvidence = await adapters.collectUiEvidence!(context);
  assert.equal(uiEvidence.passed, true, uiEvidence.issues.join('\n'));
  const reviews = await adapters.review({ ...context, requiredReviewers: ['code', 'ui'], uiEvidence }, { outcome: 'implemented', report: {} }, { passed: true, details: [] });
  const summary = JSON.parse((reviews[1].report as { summary: string }).summary) as { args: string[] };
  assert.ok(summary.args.at(-1)!.includes(uiEvidence.artifacts[0].path.replaceAll('\\', '\\\\')));
  assert.match(summary.args.at(-1)!, /fake-build-1/);
  await assert.rejects(adapters.review({ ...context, attempt: 2, requiredReviewers: ['code', 'ui'], uiEvidence }, { outcome: 'implemented', report: {} }, { passed: true, details: [] }), /another attempt/);
});

test('preserves specialist blocked verdicts and limitations', async t => {
  const adapters = await fixture(t, 'blocked', { ui: model });
  const reviews = await adapters.review(context, { outcome: 'implemented', report: {} }, { passed: true, details: [] });
  assert.equal(reviews[1].verdict, 'blocked');
  assert.deepEqual((reviews[1].report as { limitations: string[] }).limitations, ['Missing rendered evidence']);
});
