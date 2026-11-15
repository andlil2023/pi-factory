import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
