import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentAdapters } from '../src/agent-adapters.ts';
import { Orchestrator, type PlannedTask } from '../src/orchestrator.ts';
import { StateStore } from '../src/state-store.ts';

const task: PlannedTask = { id: 'T001', title: 'test', objective: 'test', scope: 'test', acceptanceCriteria: ['test'], dependencies: [], verification: [] };
const context = { task, attempt: 1, previousFeedback: [] };
const model = { provider: 'test', model: 'test' };

test('attempt verification persists selected failure and cumulative repair evidence before review and checkpoint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'task-selection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base');
  const baseline = git('rev-parse', 'HEAD');
  const log = join(dir, 'checks');
  const command = (name: string, failFirst = false) => ({ executable: process.execPath, args: ['-e', `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(name + '\n')});${failFirst ? `if(!fs.existsSync(${JSON.stringify(join(dir, 'repair'))}))process.exit(1);` : ''}`] });
  const verification = [command('a', true), command('b')];
  const adapters = createAgentAdapters({ repository: repo, factoryRoot: resolve('.'), implementer: model, reviewer: model,
    verification, baselineCommit: baseline, verificationSelection: { rules: [{path:'a',commands:[0]}, {path:'b',commands:[1]}], dependencyPaths: ['config'], dependenciesComprehensive: true } });
  const store = new StateStore(dir);
  const state = await store.create(repo, {}, [task.id], 'selection-run');
  const gates: string[] = [];
  const result = await new Orchestrator(store, {
    ...adapters,
    implement: async c => {
      if (c.attempt === 1) { await mkdir(join(repo, 'a')); await writeFile(join(repo, 'a', 'one'), 'first'); }
      else { await writeFile(join(dir, 'repair'), 'yes'); await mkdir(join(repo, 'b')); await writeFile(join(repo, 'b', 'two'), 'second'); }
      return { outcome: 'implemented', report: { filesChanged: [] } };
    },
    selectReviewers: undefined,
    review: async () => {
      const saved = (await store.load('selection-run')).tasks.T001.attempts.at(-1)!;
      assert.equal(saved.phase, 'reviewing');
      assert.deepEqual(saved.verificationProgress, {mode:'selected',completed:2,total:2,failed:0});
      gates.push('review'); return [{ reviewer: 'code', verdict: 'approved', report: {} }]; },
    checkpoint: async () => { gates.push('checkpoint'); return {commit:'checkpoint'}; }
  }, {maxAttempts: 2}).execute(state, [task]);
  assert.equal(result.status, 'completed');
  const attempts = (await store.load('selection-run')).tasks.T001.attempts;
  const first = attempts[0].verification as {passed:boolean; details:unknown}; const second = attempts[1].verification as typeof first;
  assert.equal(first.passed, false); assert.equal(second.passed, true);
  assert.equal(attempts[0].phase, 'finished');
  assert.deepEqual(attempts[0].verificationProgress, {mode:'selected',completed:1,total:1,failed:1});
  const d1 = first.details as {mode:string; reasons:string[]; evidence:{changes:{path:string}[]}; checks:{passed:boolean}[]};
  const d2 = second.details as typeof d1;
  assert.equal(d1.mode, 'selected'); assert.ok(d1.reasons.length); assert.deepEqual(d1.evidence.changes.map(c=>c.path), ['a/one']);
  assert.deepEqual(d1.checks.map(c=>c.passed), [false]);
  assert.equal(d2.mode, 'selected'); assert.deepEqual(d2.evidence.changes.map(c=>c.path).sort(), ['a/one','b/two']);
  assert.deepEqual(d2.checks.map(c=>c.passed), [true,true]);
  assert.equal(await readFile(log, 'utf8'), 'a\na\nb\n');
  assert.deepEqual(gates, ['review','checkpoint']);
});

test('selection exceptions persist full verification outcomes before review', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'task-selection-error-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const repo = join(dir, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, {cwd:repo, encoding:'utf8'}).trim();
  git('init'); git('-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','base');
  const baseline = git('rev-parse','HEAD');
  const verification = [0,1].map(n => ({executable:process.execPath, args:['-e', `console.log(${n})`]}));
  const config = {repository:repo, factoryRoot:resolve('.'), implementer:model, reviewer:model, verification, baselineCommit:baseline,
    get verificationSelection(): never { throw new Error('selection error'); }};
  const adapters = createAgentAdapters(config);
  const store = new StateStore(dir);
  const state = await store.create(repo, {}, [task.id], 'fallback-run');
  await new Orchestrator(store, {...adapters,
    implement: async () => { await writeFile(join(repo, 'change'), 'data'); return {outcome:'implemented', report:{}}; },
    selectReviewers: undefined,
    review: async () => [{reviewer:'code', verdict:'approved', report:{}}],
    checkpoint: async () => ({commit:'checkpoint'})
  }).execute(state, [task]);
  const attempt = (await store.load('fallback-run')).tasks.T001.attempts[0];
  const result = attempt.verification as {passed:boolean; details:{mode:string; reasons:string[]; evidence:{suitable:boolean}; checks:{passed:boolean}[]}};
  assert.equal(result.passed, true);
  assert.equal(result.details.mode, 'full');
  assert.match(result.details.reasons.join(' '), /Selection failed/);
  assert.equal(result.details.evidence.suitable, false);
  assert.deepEqual(result.details.checks.map(check => check.passed), [true,true]);
});

test('unreliable baseline and unknown paths fall back to every configured check', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'task-fallback-'));
  t.after(() => rm(repo, { recursive:true, force:true }));
  const git = (...args: string[]) => execFileSync('git', args, {cwd:repo, encoding:'utf8'}).trim();
  git('init'); git('-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','base');
  const baseline = git('rev-parse','HEAD');
  await writeFile(join(repo, 'unknown'), 'change');
  const verification = [0,1].map(n => ({ executable: process.execPath, args:['-e', `console.log(${n})`] }));
  for (const commit of [baseline, 'invalid']) {
    const adapters = createAgentAdapters({repository:repo, factoryRoot:resolve('.'), implementer:model, reviewer:model, verification, baselineCommit:commit,
      verificationSelection:{rules:[{path:'mapped',commands:[0]}],dependencyPaths:[],dependenciesComprehensive:true}});
    const result = await adapters.verify(context);
    const details = result.details as {mode:string; reasons:string[]; evidence:{suitable:boolean}; checks:{passed:boolean}[]};
    assert.equal(result.passed, true); assert.equal(details.mode, 'full'); assert.ok(details.reasons.length);
    assert.equal(details.checks.length, 2);
    assert.equal(details.evidence.suitable, commit === baseline);
  }
});
