import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FactoryRunState } from '../../src/state-store.ts';
import { addIntegrationRepair } from '../../src/integration-repair.ts';
import { planIdentity, type NamedObservation } from '../../src/verification-observations.ts';
import { assertSubprocessStarted, subprocessDiagnostics } from '../subprocess-diagnostics.ts';

for (const [mode, budget] of [['once', 1], ['once', 0], ['always', 1], ['incomplete', 1], ['withdraw', 1], ['dirty', 1]] as const) {
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
    await writeFile(config,JSON.stringify({agents:{planner:model,implementer:model,reviewer:model},execution:{maxAttempts:3,maxIntegrationRepairs:budget,reuseVerification:false},verification:[{name:'integration-check',executable:process.execPath,args:['-e',mode==='dirty' ? "if(process.cwd().includes('attempt-')){require('fs').writeFileSync('T001.txt','changed by a check');process.exit(1)}" : 'process.exit(0)']}],pi:{executable:process.execPath,executableArgs:[resolve('tests/fixtures/fake-integration-repair-agent.mjs'),mode]}}));
    const cli=(...args:string[])=>{const result=spawnSync(process.execPath,['--experimental-strip-types',resolve('src/factory-cli.ts'),...args,'--config',config],{encoding:'utf8',timeout:120000}); assertSubprocessStarted(result); return result;};
    const run=cli('run','--repo',repo,'--plan',plan,'--approve'); assert.equal(run.status,0,subprocessDiagnostics(run));
    const runs=join(repo,'.factory','runs'); const path=join(runs,(await readdir(runs)).find(name=>name.endsWith('.json'))!);
    const before=JSON.parse(await readFile(path,'utf8')) as FactoryRunState;
    if (mode==='once' && budget===1) {
      before.specification={store:'local',id:'fixture',sha256:'fixture-spec-hash',fetchedAt:new Date().toISOString(),text:'Fixture specification'};
      await writeFile(path,JSON.stringify(before,null,2)+'\n');
    }
    const result=cli('integrate','--repo',repo,'--run',before.runId,'--approve');
    assert.equal(result.status,mode==='once' && budget===1 ? 0 : 1,subprocessDiagnostics(result));
    const state=JSON.parse(await readFile(path,'utf8')) as FactoryRunState;
    assert.equal(git('rev-parse','HEAD'),target);
    const repairs=mode==='dirty' ? 0 : budget;
    assert.equal(state.integrationRepairs?.length??0,repairs);
    assert.equal(state.integrations?.length,mode==='once' && budget===0 || mode==='incomplete' || mode==='withdraw' || mode==='dirty' ? 1 : 2);
    assert.equal(state.integrations?.[0].status,'blocked');
    if (repairs) {
      assert.match(result.stdout,/Integration 1 blocked; added repair task T002 \(1 of 1\)/);
      assert.match(await readFile(path.replace(/\.json$/,'.events.jsonl'),'utf8'),/PLAN_REVISED.*Integration 1 blocked/);
    }
    if (mode==='once' && budget) {
      const candidate=state.integrations![1]; assert.equal(candidate.status,'ready');
      assert.equal(git('rev-list','--parents','-n','1',candidate.commit!).split(' ')[2],state.git!.expectedHead);
      assert.notEqual(state.git!.expectedHead,before.git!.expectedHead);
      const observation = (verification: {details:unknown} | undefined) => (verification!.details as {observations:NamedObservation[]}).observations;
      const expected = (attempt: typeof candidate, plan: unknown) => [{name:'integration-check',passed:true,identity:{plan:planIdentity(plan),specification:'fixture-spec-hash',implementation:git('-C',attempt.worktree,'rev-parse','HEAD^{tree}')}}];
      assert.deepEqual(observation(state.integrations![0].verification),expected(state.integrations![0],before.plan));
      assert.notEqual(planIdentity(state.plan),planIdentity(before.plan));
      assert.deepEqual(observation(candidate.verification),expected(candidate,state.plan));
      const published=cli('integrate','--repo',repo,'--run',before.runId,'--approve','--publish','--candidate',candidate.commit!);
      assert.equal(published.status,0,subprocessDiagnostics(published));
      const after=JSON.parse(await readFile(path,'utf8')) as FactoryRunState;
      assert.deepEqual(observation(after.integrations![1].publicationVerification),expected(candidate,state.plan));
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
    if (mode==='dirty') {
      // A failing check that changed the candidate: the rejection is void, so nothing is repaired or prepared again.
      assert.match(result.stdout,/Integration 1 is not repaired automatically/);
      assert.deepEqual(Object.keys(state.tasks),['T001']);
      assert.equal(state.status,'completed');
    }
    if (mode==='always') assert.equal(state.integrations![1].status,'blocked');
    if (mode==='incomplete') assert.match(result.stdout,/T002: .*resume/);
    if (mode==='withdraw') assert.equal(state.integrationRepairs![0].withdrawn,true);
  });
}

test('a repair that was scheduled but never started is resumed without replaying accepted tasks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-int-repair-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const repo=join(dir,'project'); await mkdir(repo);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
  git('init'); git('config','user.name','Test'); git('config','user.email','test@example.invalid'); git('config','core.autocrlf','false');
  await writeFile(join(repo,'.gitignore'),'.factory/\n'); git('add','.'); git('commit','-m','initial');
  const plan=join(dir,'plan.json');
  await writeFile(plan,JSON.stringify({objective:'Fixture',assumptions:[],decisions:[],verification:['test'],tasks:[{id:'T001',title:'Task',objective:'Write file',scope:'T001.txt',acceptanceCriteria:['File exists'],dependencies:[],verification:['test']}]}));
  const config=join(dir,'config.json'); const model={provider:'fixture',model:'fixture'};
  // Budget 0: the first integration is rejected and left alone, which gives the state just before a repair is scheduled.
  await writeFile(config,JSON.stringify({agents:{planner:model,implementer:model,reviewer:model},execution:{maxAttempts:3,maxIntegrationRepairs:0},verification:[{executable:process.execPath,args:['-e','process.exit(0)']}],pi:{executable:process.execPath,executableArgs:[resolve('tests/fixtures/fake-integration-repair-agent.mjs'),'once']}}));
  const cli=(...args:string[])=>{const result=spawnSync(process.execPath,['--experimental-strip-types',resolve('src/factory-cli.ts'),...args,'--config',config],{encoding:'utf8',timeout:120000}); assertSubprocessStarted(result); return result;};
  const run=cli('run','--repo',repo,'--plan',plan,'--approve'); assert.equal(run.status,0,subprocessDiagnostics(run));
  const runs=join(repo,'.factory','runs'); const path=join(runs,(await readdir(runs)).find(name=>name.endsWith('.json'))!);
  const runId=(JSON.parse(await readFile(path,'utf8')) as FactoryRunState).runId;
  const blocked=cli('integrate','--repo',repo,'--run',runId,'--approve'); assert.equal(blocked.status,1,subprocessDiagnostics(blocked));
  const rejected=JSON.parse(await readFile(path,'utf8')) as FactoryRunState;
  // The snapshot the integrate command saves before it starts the repair task; the process is taken to stop right after.
  const scheduled=addIntegrationRepair(rejected,rejected.integrations![0],1);
  assert.notEqual(scheduled.status,'completed');
  await writeFile(path,JSON.stringify(scheduled,null,2)+'\n');
  const refused=cli('integrate','--repo',repo,'--run',runId,'--approve','--new-attempt');
  assert.equal(refused.status,1,'a run with a pending repair is not integrable');
  const resumed=cli('resume','--repo',repo,'--run',runId,'--approve'); assert.equal(resumed.status,0,subprocessDiagnostics(resumed));
  const state=JSON.parse(await readFile(path,'utf8')) as FactoryRunState;
  assert.equal(state.status,'completed');
  assert.equal(state.tasks.T001.attempts.length,1,'the accepted task is not replayed');
  assert.equal(state.tasks.T001.checkpointCommit,rejected.tasks.T001.checkpointCommit);
  assert.equal(state.tasks.T002.status,'completed');
  assert.equal(state.tasks.T002.attempts.length,1);
  assert.notEqual(state.git!.expectedHead,rejected.git!.expectedHead);
  const fresh=cli('integrate','--repo',repo,'--run',runId,'--approve','--new-attempt'); assert.equal(fresh.status,0,subprocessDiagnostics(fresh));
  const after=JSON.parse(await readFile(path,'utf8')) as FactoryRunState;
  assert.deepEqual(after.integrations?.map(attempt=>attempt.status),['blocked','ready']);
});
