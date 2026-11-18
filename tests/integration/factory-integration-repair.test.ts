import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FactoryRunState } from '../../src/state-store.ts';
import { assertSubprocessStarted, subprocessDiagnostics } from '../subprocess-diagnostics.ts';

for (const [mode, budget] of [['once', 1], ['once', 0], ['always', 1], ['incomplete', 1], ['withdraw', 1]] as const) {
  test(`integration repair: ${mode}, budget ${budget}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-int-repair-'));
    t.after(() => rm(dir, {recursive:true,force:true}));
    const repo=join(dir,'project'); await mkdir(repo);
    const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
    git('init'); git('config','user.name','Test'); git('config','user.email','test@example.invalid'); git('config','core.autocrlf','false');
    await writeFile(join(repo,'.gitignore'),'.factory/\n'); git('add','.'); git('commit','-m','initial');
    const target=git('rev-parse','HEAD');
    const plan=join(dir,'plan.json');
    await writeFile(plan,JSON.stringify({objective:'Fixture',assumptions:[],decisions:[],verification:['test'],tasks:[{id:'T001',title:'Task',objective:'Write file',scope:'T001.txt',acceptanceCriteria:['File exists'],dependencies:[],verification:['test']}]}));
    const config=join(dir,'config.json'); const model={provider:'fixture',model:'fixture'};
    await writeFile(config,JSON.stringify({agents:{planner:model,implementer:model,reviewer:model},execution:{maxAttempts:3,maxIntegrationRepairs:budget},verification:[{executable:process.execPath,args:['-e','process.exit(0)']}],pi:{executable:process.execPath,executableArgs:[resolve('tests/fixtures/fake-integration-repair-agent.mjs'),mode]}}));
    const cli=(...args:string[])=>{const result=spawnSync(process.execPath,['--experimental-strip-types',resolve('src/factory-cli.ts'),...args,'--config',config],{encoding:'utf8',timeout:120000}); assertSubprocessStarted(result); return result;};
    const run=cli('run','--repo',repo,'--plan',plan,'--approve'); assert.equal(run.status,0,subprocessDiagnostics(run));
    const runs=join(repo,'.factory','runs'); const path=join(runs,(await readdir(runs)).find(name=>name.endsWith('.json'))!);
    const before=JSON.parse(await readFile(path,'utf8')) as FactoryRunState;
    const result=cli('integrate','--repo',repo,'--run',before.runId,'--approve');
    assert.equal(result.status,mode==='once' && budget===1 ? 0 : 1,subprocessDiagnostics(result));
    const state=JSON.parse(await readFile(path,'utf8')) as FactoryRunState;
    assert.equal(git('rev-parse','HEAD'),target);
    assert.equal(state.integrationRepairs?.length??0,budget);
    assert.equal(state.integrations?.length,mode==='once' && budget===0 || mode==='incomplete' || mode==='withdraw' ? 1 : 2);
    assert.equal(state.integrations?.[0].status,'blocked');
    if (budget) {
      assert.match(result.stdout,/Integration 1 blocked; added repair task T002 \(1 of 1\)/);
      assert.match(await readFile(path.replace(/\.json$/,'.events.jsonl'),'utf8'),/PLAN_REVISED.*Integration 1 blocked/);
    }
    if (mode==='once' && budget) {
      const candidate=state.integrations![1]; assert.equal(candidate.status,'ready');
      assert.equal(git('rev-list','--parents','-n','1',candidate.commit!).split(' ')[2],state.git!.expectedHead);
      assert.notEqual(state.git!.expectedHead,before.git!.expectedHead);
    }
    if (mode==='once' && budget===0) {
      const settings=JSON.parse(await readFile(config,'utf8'));
      settings.execution.maxIntegrationRepairs=1;
      await writeFile(config,JSON.stringify(settings));
      const retry=cli('integrate','--repo',repo,'--run',before.runId,'--approve');
      assert.equal(retry.status,1,subprocessDiagnostics(retry));
      assert.match(retry.stderr,/explicitly pass --new-attempt/);
      const fresh=cli('integrate','--repo',repo,'--run',before.runId,'--approve','--new-attempt');
      assert.equal(fresh.status,0,subprocessDiagnostics(fresh));
      const after=JSON.parse(await readFile(path,'utf8')) as FactoryRunState;
      assert.equal(after.integrationRepairs?.length??0,0);
      assert.deepEqual(after.integrations?.map(attempt=>attempt.status),['blocked','ready']);
    }
    if (mode==='always') assert.equal(state.integrations![1].status,'blocked');
    if (mode==='incomplete') assert.match(result.stdout,/T002: .*resume/);
    if (mode==='withdraw') assert.equal(state.integrationRepairs![0].withdrawn,true);
  });
}
