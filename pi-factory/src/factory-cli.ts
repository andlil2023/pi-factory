import { FactoryEventBus } from './event-bus.ts';
import { readFile, writeFile, mkdir, open, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPi } from './pi-runner.ts';
import { ContractValidator } from './contract-validator.ts';
import { createWorktree } from './git-worktree.ts';
import { StateStore } from './state-store.ts';
import { Orchestrator, type PlannedTask } from './orchestrator.ts';
import { createAgentAdapters, type AgentModel } from './agent-adapters.ts';
import { createGitCheckpoint } from './git-checkpoint.ts';
import { spawn } from 'node:child_process';
import { inspectResume } from './resume-guard.ts';
import type { FactoryRunState } from './state-store.ts';

interface Config {
  agents: { planner: AgentModel; implementer: AgentModel; reviewer: AgentModel };
  execution?: { maxAttempts?: number };
  verification?: Array<{ executable: string; args?: string[]; timeoutMs?: number }>;
  pi?: { executable?: string; executableArgs?: string[] };
}
interface Plan { objective: string; assumptions: string[]; decisions: Array<{id:string;question:string;blocking:boolean;affectedTasks:string[]}>; tasks: PlannedTask[]; verification: string[] }
const root = resolve(import.meta.dirname, '..');
const validator = new ContractValidator(join(root, 'contracts'));
function argsMap(argv: string[]): {command:string; flags:Record<string,string|boolean>} {
  const [command, ...rest] = argv;
  const flags: Record<string,string|boolean> = {};
  for (let i=0;i<rest.length;i++) {
    const part = rest[i];
    if (!part.startsWith('--')) throw new Error(`Unexpected argument: ${part}`);
    const eq = part.indexOf('=');
    if (eq !== -1) flags[part.slice(2,eq)] = part.slice(eq+1);
    else if (rest[i+1] && !rest[i+1].startsWith('--')) flags[part.slice(2)] = rest[++i];
    else flags[part.slice(2)] = true;
  }
  return {command,flags};
}
function required(flags:Record<string,string|boolean>,name:string):string {
  const value=flags[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing --${name}`);
  return value;
}
function piLaunch(config:Config):{executable:string;executableArgs:string[]} {
  if (config.pi?.executable) return {executable:config.pi.executable,executableArgs:config.pi.executableArgs??[]};
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) throw new Error('APPDATA not set; configure pi.executable and pi.executableArgs');
    return {executable:process.execPath,executableArgs:[join(process.env.APPDATA,'npm','node_modules','@earendil-works','pi-coding-agent','dist','bundle','cli.js')]};
  }
  return {executable:'pi',executableArgs:[]};
}
function assistantText(events:unknown[]):string {
  let last='';
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const e=event as {type?:unknown;message?:{role?:string;content?:Array<{type?:string;text?:string}>}};
    if (e.type==='message_end' && e.message?.role==='assistant') {
      const text=e.message.content?.filter(c=>c.type==='text').map(c=>c.text??'').join('')??'';
      if(text.trim()) last=text.trim();
    }
  }
  const fence=/^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(last);
  return fence?fence[1].trim():last;
}
async function configFrom(flags:Record<string,string|boolean>):Promise<Config> {
  const path=resolve(typeof flags.config==='string'?flags.config:join(root,'factory.config.json'));
  const config=JSON.parse(await readFile(path,'utf8')) as Config;
  if (!config.agents?.planner || !config.agents?.implementer || !config.agents?.reviewer) throw new Error('Configuration requires agents.planner, implementer and reviewer');
  return config;
}
async function planCommand(flags:Record<string,string|boolean>):Promise<void> {
  const repository=resolve(required(flags,'repo'));
  const objectivePath=resolve(required(flags,'objective'));
  const output=resolve(required(flags,'output'));
  const config=await configFrom(flags);
  const launch=piLaunch(config);
  const objective=(await readFile(objectivePath,'utf8')).trim();
  if(!objective) throw new Error('Objective file is empty');
  const schema=await readFile(join(root,'contracts','plan.schema.json'),'utf8');
  const response=await runPi({role:'planner',repository,instructionsFile:join(root,'agents','planner.md'),...launch,
    ...config.agents.planner,tools:['read','grep','find','ls'],
    prompt:`Plan the following objective. Do not modify files. Return ONLY valid JSON matching the schema.\n\nObjective:\n${objective}\n\nSchema:\n${schema}`});
  const validation=await validator.validate<Plan>('plan',assistantText(response.events));
  if(!validation.valid) throw new Error(`Planner contract invalid: ${JSON.stringify(validation.issues,null,2)}`);
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(validation.value,null,2)+'\n',{flag:'wx'});
  console.log(`Plan saved to ${output} (${validation.value.tasks.length} tasks). Review it before running.`);
}

async function runVerificationCommand(cwd: string, command: {executable:string;args?:string[];timeoutMs?:number}): Promise<{command:string;passed:boolean;stdout:string;stderr:string}> {
  return new Promise(resolveResult => {
    const child = spawn(command.executable, command.args ?? [], {cwd, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '', settled = false;
    const finish = (passed:boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({command:[command.executable,...(command.args??[])].join(' '),passed,stdout,stderr});
    };
    child.stdout.on('data', (data:Buffer) => {stdout+=data.toString();});
    child.stderr.on('data', (data:Buffer) => {stderr+=data.toString();});
    const timer = setTimeout(() => { stderr+='\nVerification timeout'; child.kill(); finish(false); },command.timeoutMs??120000);
    child.on('error', error => {stderr+=String(error); finish(false);});
    child.on('close', code => finish(code===0));
  });
}

async function runCommand(flags:Record<string,string|boolean>):Promise<void> {
  if(flags.approve !== true) throw new Error('Execution requires --approve after reviewing the plan');
  const repository=resolve(required(flags,'repo'));
  const planPath=resolve(required(flags,'plan'));
  const config=await configFrom(flags);
  if(!config.verification?.length) throw new Error('Configure at least one trusted verification command in factory.config.json');
  const parsed:unknown=JSON.parse(await readFile(planPath,'utf8'));
  const validation=await validator.validate<Plan>('plan',parsed);
  if(!validation.valid) throw new Error(`Invalid plan: ${JSON.stringify(validation.issues)}`);
  if(validation.value.decisions.some(d=>d.blocking)) throw new Error('Plan has unresolved blocking decisions');
  const runId=`run-${randomUUID()}`;
  // Worktree must be created before writing state into the source repository.
  const worktree=await createWorktree({repository,runId});
  const store=new StateStore(repository);
  const state=await store.create(repository,validation.value,validation.value.tasks.map(t=>t.id),runId);
  await executeExistingRun(repository, config, store, state, worktree.path, worktree.baseCommit, false);
}

async function executeExistingRun(repository: string, config: Config, store: StateStore, state: FactoryRunState, worktreePath: string, initialHead: string, resumed: boolean): Promise<void> {
  const lockPath = join(repository, '.factory', 'runs', `${state.runId}.lock`);
  const lock = await open(lockPath, 'wx').catch(error => { throw new Error(`Run is locked or cannot be locked: ${String(error)}`); });
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');
  try {
  const validation=await validator.validate<Plan>('plan',state.plan);
  if (!validation.valid) throw new Error(`Persisted plan is invalid: ${JSON.stringify(validation.issues)}`);
  const launch=piLaunch(config);
  const adapterConfig = {repository:worktreePath,factoryRoot:root,
    piExecutable:launch.executable,piExecutableArgs:launch.executableArgs,
    implementer:config.agents.implementer,reviewer:config.agents.reviewer,
    verification:config.verification,baselineCommit:initialHead};
  const adapters=createAgentAdapters(adapterConfig);
  console.log(`Run ${state.runId}; worktree: ${worktreePath}`);
  let expectedHead = initialHead;
  const integratedAdapters = {
    ...adapters,
    checkpoint: async (context: {task: PlannedTask}) => {
      const checkpoint = await createGitCheckpoint({
        worktree: worktreePath, branch: `factory/${state.runId}`,
        taskId: context.task.id, title: context.task.title,
        expectedHead
      });
      expectedHead = checkpoint.commit;
      adapterConfig.baselineCommit = checkpoint.commit;
      return { commit: checkpoint.commit };
    },
    finalVerify: async () => {
      const details: Array<{command:string;passed:boolean;stdout:string;stderr:string}> = [];
      for (const command of config.verification ?? []) {
        const outcome = await runVerificationCommand(worktreePath, command);
        details.push(outcome);
        if (!outcome.passed) return {passed:false,details};
      }
      return {passed:true,details};
    }
  };
  const events=new FactoryEventBus({runId:state.runId,logFile:join(repository,'.factory','runs',`${state.runId}.events.jsonl`)});
  if (resumed) events.emit({type:'RUN_RESUMED'});
  const orchestrator=new Orchestrator(store,integratedAdapters,{maxAttempts:config.execution?.maxAttempts??3,requiredReviewers:['code'],events});
  let finished: FactoryRunState;
  try {
    finished=await orchestrator.execute(state,validation.value.tasks);
  } finally {
    await events.close();
  }
  console.log(`Run ${finished.runId}: ${finished.status}`);
  for(const task of Object.values(finished.tasks)) console.log(`${task.id}: ${task.status}${task.lastError?` (${task.lastError})`:''}`);
  if(finished.status!=='completed') process.exitCode=1;
  } finally { await lock.close(); await rm(lockPath,{force:true}); }
}
async function resumeCommand(flags:Record<string,string|boolean>):Promise<void> {
  if (flags.approve !== true) throw new Error('Resume requires --approve');
  const repository=resolve(required(flags,'repo'));
  const runId=required(flags,'run');
  const config=await configFrom(flags);
  if (!config.verification?.length) throw new Error('Configure trusted verification commands');
  const store=new StateStore(repository);
  const state=await store.load(runId);
  // This intentionally rejects interrupted in-flight attempts and dirty worktrees.
  // It safely resumes only between tasks; recovery of partial edits is a later feature.
  const {worktree,head}=await inspectResume(state,repository);
  await executeExistingRun(repository,config,store,state,worktree,head,true);
}
async function statusCommand(flags:Record<string,string|boolean>):Promise<void> {
  const store=new StateStore(resolve(required(flags,'repo')));
  const state=await store.load(required(flags,'run'));
  console.log(`Run ${state.runId}: ${state.status}`);
  for(const task of Object.values(state.tasks)) console.log(`${task.id}: ${task.status}, attempts=${task.attempts.length}${task.lastError?` — ${task.lastError}`:''}`);
}
async function main():Promise<void> {
  const {command,flags}=argsMap(process.argv.slice(2));
  if(command==='plan') return planCommand(flags);
  if(command==='run') return runCommand(flags);
  if(command==='resume') return resumeCommand(flags);
  if(command==='status') return statusCommand(flags);
  console.log('Usage:\n  npm run factory -- plan --repo PATH --objective FILE --output FILE\n  npm run factory -- run --repo PATH --plan FILE --approve\n  npm run factory -- resume --repo PATH --run RUN_ID --approve\n  npm run factory -- status --repo PATH --run RUN_ID');
  if(command) process.exitCode=1;
}
main().catch(e=>{console.error(e instanceof Error?e.stack:e);process.exitCode=1;});
