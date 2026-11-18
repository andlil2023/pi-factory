import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FactoryRunState } from '../src/state-store.ts';
import { assertSubprocessStarted, subprocessDiagnostics } from './subprocess-diagnostics.ts';

for (const gate of ['final', 'preparation', 'publication'] as const) test(`${gate} runs all trusted checks despite task selection and blocks on failure`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-full-gate-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const repo = join(dir, 'project'); await mkdir(repo);
  const git = (...args:string[]) => execFileSync('git', args, {cwd:repo, encoding:'utf8'}).trim();
  git('init'); git('config','user.name','Test'); git('config','user.email','test@example.invalid');
  await writeFile(join(repo, '.gitignore'), '.factory/\n');
  git('add','.'); git('commit','-m','initial');
  const base = git('rev-parse','HEAD');
  const marker = join(dir, 'fail'); const log = join(dir, 'checks');
  const verification = [0,1,2].map(n => ({executable:process.execPath, args:['-e',
    `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${n}\\n');${n === 1 ? `if(fs.existsSync(${JSON.stringify(marker)}))process.exit(1);` : ''}`]}));
  const model = {provider:'fixture',model:'fixture'};
  const config = join(dir, 'config.json');
  // Reruns of failed commands are disabled so the log counts exactly one execution per selected check.
  await writeFile(config, JSON.stringify({agents:{planner:model,implementer:model,reviewer:model}, verification, execution:{verificationReruns:0},
    verificationSelection:{rules:[{path:'T001.txt',commands:[0]}],dependencyPaths:[],dependenciesComprehensive:true},
    pi:{executable:process.execPath,executableArgs:[resolve('tests/fixtures/fake-factory-agent.mjs')]}}));
  const plan = join(dir,'plan.json');
  await writeFile(plan, JSON.stringify({objective:'Fixture',assumptions:[],decisions:[],tasks:[{id:'T001',title:'Fixture',objective:'Write file',scope:'T001.txt',acceptanceCriteria:['Exists'],dependencies:[],verification:['check']}],verification:['check']}));
  const cli = (...args:string[]) => {
    const result = spawnSync(process.execPath,['--experimental-strip-types',resolve('src/factory-cli.ts'),...args,'--config',config],{encoding:'utf8',timeout: 180_000});
    assertSubprocessStarted(result);
    return result;
  };
  if (gate === 'final') await writeFile(marker,'fail');
  const run = cli('run','--repo',repo,'--plan',plan,'--approve');
  assert.equal(run.status, gate === 'final' ? 1 : 0, subprocessDiagnostics(run));
  const runs = join(repo,'.factory','runs');
  const statePath = join(runs,(await readdir(runs)).find(f=>f.endsWith('.json'))!);
  const load = async () => JSON.parse(await readFile(statePath,'utf8')) as FactoryRunState;
  let state = await load();
  const attempt = state.tasks.T001.attempts[0].verification as {details:{mode:string;checks:unknown[]}};
  assert.equal(attempt.details.mode,'selected'); assert.equal(attempt.details.checks.length,1);
  assert.equal(await readFile(log,'utf8'), '0\n0\n1\n2\n');
  if (gate === 'final') {
    assert.equal(state.status,'blocked'); assert.equal(state.finalVerification?.passed,false);
    assert.equal(git('rev-parse','HEAD'),base); return;
  }
  if (gate === 'preparation') await writeFile(marker,'fail');
  await writeFile(log,'');
  const prepared = cli('integrate','--repo',repo,'--run',state.runId,'--approve');
  assert.equal(prepared.status, gate === 'preparation' ? 1 : 0, subprocessDiagnostics(prepared));
  state = await load(); const candidate = state.integrations!.at(-1)!;
  assert.equal(await readFile(log,'utf8'),'0\n1\n2\n');
  if (gate === 'preparation') {
    assert.equal(candidate.status,'blocked'); assert.equal(candidate.verification?.passed,false);
    assert.equal(git('rev-parse','HEAD'),base); return;
  }
  assert.equal(candidate.status,'ready');
  await writeFile(marker,'fail'); await writeFile(log,'');
  const published = cli('integrate','--repo',repo,'--run',state.runId,'--publish','--candidate',candidate.commit!,'--approve');
  assert.notEqual(published.status,0, subprocessDiagnostics(published));
  state = await load();
  assert.equal(state.integrations!.at(-1)!.status,'blocked');
  assert.equal(state.integrations!.at(-1)!.publicationVerification?.passed,false);
  assert.equal(await readFile(log,'utf8'),'0\n1\n2\n');
  assert.equal(git('rev-parse','HEAD'),base);
});
