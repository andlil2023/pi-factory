import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli=resolve('src/factory-cli.ts');
test('doctor inspects Git readiness without changing state or executing hooks and filters', async () => {
  const dir=await mkdtemp(join(tmpdir(),'doctor-repo-')); const repo=join(dir,'repo'); await mkdir(repo);
  const globalConfig=join(dir,'global'); await writeFile(globalConfig,'');
  const env={...process.env,GIT_CONFIG_GLOBAL:globalConfig,GIT_CONFIG_NOSYSTEM:'1'};
  const git=(...args:string[]) => { const r=spawnSync('git',args,{cwd:repo,encoding:'utf8',env}); assert.equal(r.status,0,r.stderr); return r.stdout; };
  git('init'); git('config','user.email','test@example.com'); git('config','user.name','Test');
  await writeFile(join(repo,'file'),'initial'); git('add','file'); git('commit','-m','initial');
  const config=join(dir,'config.json'); await writeFile(config,JSON.stringify({agents:{planner:{},implementer:{},reviewer:{}},pi:{executable:process.execPath},verification:[{executable:process.execPath}]}));
  const doctor=(path=repo) => spawnSync(process.execPath,['--experimental-strip-types',cli,'doctor','--config',config,'--repo',path],{encoding:'utf8',env});
  const snapshot=async (path:string):Promise<string[]> => {
    const entries=await readdir(path,{withFileTypes:true}); const result:string[]=[];
    for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      const p=join(path,entry.name);
      if (entry.isDirectory()) result.push(...await snapshot(p));
      else if (entry.isFile()) result.push(`${p}:${(await readFile(p)).toString('base64')}`);
    }
    return result;
  };
  let before=await snapshot(repo); const clean=doctor(); assert.equal(clean.status,0,clean.stderr); assert.match(clean.stdout,/Blockers:\s*- none/); assert.deepEqual(await snapshot(repo),before);
  for (const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer','BISECT_LOG']) {
    const path=join(repo,'.git',marker); await writeFile(path,'unfinished'); before=await snapshot(repo);
    const result=doctor(); assert.equal(result.status,1); assert.match(result.stdout,/unfinished Git operation/); assert.deepEqual(await snapshot(repo),before); await unlink(path);
  }
  await writeFile(join(repo,'file'),'changed'); before=await snapshot(repo);
  const dirty=doctor(); assert.equal(dirty.status,1); assert.match(dirty.stdout,/commit, stash/); assert.deepEqual(await snapshot(repo),before);
  const marker=join(dir,'executed'); const script=join(dir,'hook.cjs'); await writeFile(script,`require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`);
  const command=`"${process.execPath}" "${script}"`; git('config','core.fsmonitor',command); git('config','filter.danger.clean',command);
  await writeFile(join(repo,'.gitattributes'),'file filter=danger\n'); before=await snapshot(repo);
  const filtered=doctor(); assert.equal(filtered.status,1); assert.match(filtered.stdout,/status inspection unavailable/); await assert.rejects(readFile(marker),{code:'ENOENT'}); assert.deepEqual(await snapshot(repo),before);
  const runs=join(repo,'.factory','runs'); await mkdir(runs,{recursive:true});
  const state=(id:string,status:string,taskStatus:string,attempts:unknown[]=[])=>JSON.stringify({version:1,runId:id,repository:repo,createdAt:'now',updatedAt:'now',status,tasks:{T001:{id:'T001',status:taskStatus,attempts}}});
  await writeFile(join(runs,'paused.json'),state('paused','paused','needs_review'));
  await writeFile(join(runs,'running.json'),state('running','running','pending'));
  await writeFile(join(runs,'interrupted.json'),state('interrupted','paused','pending',[{number:1,startedAt:'now',finishedAt:'later',outcome:'interrupted'}]));
  await writeFile(join(runs,'bad.json'),'secret malformed record');
  await writeFile(join(runs,'missing.lock'),'secret lock content');
  await writeFile(join(runs,'orphan.lock.recovery'),'secret sentinel content');
  before=await snapshot(repo); const diagnosed=doctor();
  assert.match(diagnosed.stdout,/lock records exist/); assert.match(diagnosed.stdout,/recovery sentinels exist/);
  assert.match(diagnosed.stdout,/missing or invalid/); assert.match(diagnosed.stdout,/review-pending/); assert.match(diagnosed.stdout,/not process liveness/);
  assert.doesNotMatch(diagnosed.stdout,/secret/); assert.deepEqual(await snapshot(repo),before);
  await unlink(join(runs,'running.json')); await unlink(join(runs,'interrupted.json'));
  before=await snapshot(repo); assert.match(doctor().stdout,/review-pending/); assert.deepEqual(await snapshot(repo),before);
  const invalid=doctor(dir); assert.equal(invalid.status,1); assert.match(invalid.stdout,/select a Git working-tree root/);
});
