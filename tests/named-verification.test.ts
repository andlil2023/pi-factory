import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentAdapters } from '../src/agent-adapters.ts';
import { implementationIdentity, planIdentity, validateVerificationCommands, type NamedObservation } from '../src/verification-observations.ts';
import { ContractValidator } from '../src/contract-validator.ts';
import { StateStore } from '../src/state-store.ts';

const task = { id:'T001', title:'test', objective:'test', scope:'test', acceptanceCriteria:['behavior'], criterionChecks:[{criterion:0,checks:['target']}], dependencies:[], verification:['test'] };
const plan = { objective:'test', assumptions:[], decisions:[], tasks:[task], verification:['test'] };

test('real named checks record results and revision identities, never unnamed suite results', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'named-check-'));
  const git = (...args: string[]) => execFileSync('git', args, {cwd:repo, stdio:'ignore'});
  try {
    git('init'); git('config','user.email','test@example.com'); git('config','user.name','Test');
    await writeFile(join(repo,'file'), 'base'); git('add','.'); git('commit','-m','base');
    await writeFile(join(repo,'file'), 'changed');
    const adapters = createAgentAdapters({ repository:repo, factoryRoot:resolve('.'), implementer:{provider:'x',model:'x'}, reviewer:{provider:'x',model:'x'}, baselineCommit:'HEAD', verificationContext:()=>({plan,specification:'spec-hash'}), verification:[
      {name:'target',executable:process.execPath,args:['-e','process.exit(0)']},
      {name:'failure',executable:process.execPath,args:['-e','process.exit(1)']},
      {name:'unrelated',executable:process.execPath,args:['-e','process.exit(0)']},
      {executable:process.execPath,args:['-e','process.exit(0)']},
    ] });
    const result = await adapters.verify({task,attempt:1,previousFeedback:[],fullVerification:true});
    const observations = (result.details as {observations:NamedObservation[]}).observations;
    assert.deepEqual(observations.map(({name,passed})=>({name,passed})), [{name:'target',passed:true},{name:'failure',passed:false},{name:'unrelated',passed:true}]);
    assert.deepEqual(observations[0].identity, {plan:planIdentity(plan),specification:'spec-hash',implementation:await implementationIdentity(repo)});
    const store = new StateStore(repo);
    const state = await store.create(repo, plan, ['T001'], 'test-run');
    state.tasks.T001.attempts.push({number:1,startedAt:new Date().toISOString(),verification:result});
    await store.save(state);
    const saved = await store.load('test-run');
    assert.deepEqual(((saved.tasks.T001.attempts[0].verification as typeof result).details as {observations:NamedObservation[]}).observations, observations);
    await writeFile(join(repo,'file'), 'new revision');
    assert.notEqual(observations[0].identity!.implementation, await implementationIdentity(repo));
    assert.notEqual(observations[0].identity!.plan, planIdentity({...plan, objective:'new plan'}));
  } finally { await rm(repo,{recursive:true,force:true}); }
});

test('a named check that changes its input cannot claim a revision', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'mutating-check-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, {cwd:repo, stdio:'ignore'});
    git('init'); git('config','user.email','test@example.com'); git('config','user.name','Test');
    await writeFile(join(repo,'file'), 'base'); git('add','.'); git('commit','-m','base');
    const adapters = createAgentAdapters({repository:repo,factoryRoot:resolve('.'),implementer:{provider:'x',model:'x'},reviewer:{provider:'x',model:'x'},baselineCommit:'HEAD',verificationContext:()=>({plan,specification:null}),verification:[{name:'mutates',executable:process.execPath,args:['-e',"require('fs').writeFileSync('file','modified')"]}]});
    const result = await adapters.verify({task,attempt:1,previousFeedback:[],fullVerification:true});
    assert.deepEqual((result.details as {observations:NamedObservation[]}).observations, [{name:'mutates',passed:true,identity:null}]);
  } finally { await rm(repo,{recursive:true,force:true}); }
});

test('invalid or duplicate trusted check names are rejected', () => {
  assert.throws(()=>validateVerificationCommands([{name:'x',executable:'a'},{name:'x',executable:'b'}]));
  assert.throws(()=>validateVerificationCommands([{name:'',executable:'a'}]));
});

test('criterion mappings are explicit and validated without requiring legacy plans to change', async () => {
  const validator = new ContractValidator(resolve('contracts'));
  assert.equal((await validator.validate('plan',plan)).valid,true);
  assert.equal((await validator.validate('plan',{...plan,tasks:[{...task,criterionChecks:[{criterion:1,checks:['target']}]}]})).valid,false);
  assert.equal((await validator.validate('plan',{...plan,tasks:[{...task,criterionChecks:[{criterion:0,checks:['target']},{criterion:0,checks:['other']}]}]})).valid,false);
});
