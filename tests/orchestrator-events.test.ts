import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.ts';
import { Orchestrator, type OrchestratorAdapters, type PlannedTask } from '../src/orchestrator.ts';
import { FactoryEventBus, type FactoryEvent } from '../src/event-bus.ts';

const task: PlannedTask = {id:'T001',title:'Demo',objective:'Demo',scope:'Demo',acceptanceCriteria:['works'],dependencies:[],verification:['test']};

test('emits lifecycle, repair and checkpoint events in order', async t => {
  const dir = await mkdtemp(join(tmpdir(),'factory-events-orch-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const store = new StateStore(dir);
  const state = await store.create(dir,{},['T001'],'event-run');
  const bus = new FactoryEventBus({runId:'event-run',consoleOutput:false});
  const events: FactoryEvent[]=[];
  bus.subscribe(e=>events.push(e));
  const adapters: OrchestratorAdapters={
    implement:async()=>({outcome:'implemented',report:{}}),
    verify:async()=>({passed:true,details:{}}),
    review:async c=>[{reviewer:'code',verdict:c.attempt===1?'changes_requested':'approved',report:{}}],
    checkpoint:async()=>({commit:'abc123'}),
    finalVerify:async()=>({passed:true,details:{}})
  };
  const result=await new Orchestrator(store,adapters,{events:bus}).execute(state,[task]);
  await bus.close();
  assert.equal(result.status,'completed');
  const types=events.map(e=>e.type);
  assert.ok(types.indexOf('REVIEW_CHANGES_REQUESTED')<types.indexOf('REPAIR_STARTED'));
  assert.ok(types.indexOf('CHECKPOINT_CREATED')<types.indexOf('FINAL_VERIFICATION_PASSED'));
  assert.equal(types.at(-1),'RUN_COMPLETED');
  assert.equal(events.find(e=>e.type==='REPAIR_STARTED')?.attempt,2);
});

test('persists verification start before the adapter and identifies both outcomes across retries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-verification-events-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const store = new StateStore(dir);
  const state = await store.create(dir, {}, ['T001'], 'verification-run');
  const logFile = join(dir, 'events.jsonl');
  const bus = new FactoryEventBus({runId:'verification-run', logFile, consoleOutput:false});
  const adapters: OrchestratorAdapters = {
    implement: async () => ({outcome:'implemented', report:{}}),
    verify: async context => {
      const persisted = (await readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(persisted.filter(e => e.type === 'VERIFICATION_STARTED').map(e => [e.taskId, e.attempt]),
        Array.from({length:context.attempt}, (_, i) => ['T001', i + 1]));
      assert.equal(persisted.some(e => e.attempt === context.attempt && (e.type === 'VERIFICATION_PASSED' || e.type === 'VERIFICATION_FAILED')), false);
      return {passed:context.attempt === 2, details:{stdout:'SECRET_OUTPUT'}};
    },
    review: async () => [{reviewer:'code', verdict:'approved', report:{}}],
    checkpoint: async () => ({commit:'abc123'}),
    finalVerify: async () => ({passed:true, details:{}})
  };
  const result = await new Orchestrator(store, adapters, {events:bus, maxAttempts:2}).execute(state, [task]);
  await bus.close();
  assert.equal(result.status, 'completed');
  const persisted = (await readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(persisted.filter(e => e.type.startsWith('VERIFICATION_')).map(e => [e.type, e.taskId, e.attempt]), [
    ['VERIFICATION_STARTED','T001',1], ['VERIFICATION_FAILED','T001',1],
    ['VERIFICATION_STARTED','T001',2], ['VERIFICATION_PASSED','T001',2]
  ]);
  assert.doesNotMatch(JSON.stringify(persisted), /SECRET_OUTPUT/);
});
