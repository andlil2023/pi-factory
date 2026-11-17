import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const cli=resolve('src/factory-cli.ts');
test('run-list safely displays persisted evidence without changing files or git', async () => {
  const repo=await mkdtemp(join(tmpdir(),'factory-list-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'});
  try {
    git('init');
    const dir=join(repo,'.factory','runs'); await mkdir(dir,{recursive:true});
    const base={version:1,repository:repo,createdAt:'2025-01-01T00:00:00.000Z',updatedAt:'2025-01-02T00:00:00.000Z',status:'blocked',plan:{objective:'Improve CLI testing password=secret SENTINEL'},tasks:{T001:{id:'T001',status:'blocked',attempts:[{number:1,startedAt:'x',outcome:'blocked',implementationReport:{blockers:[{kind:'decision_needed',description:'SENTINEL'}]}}]}}};
    await writeFile(join(dir,'valid.json'),JSON.stringify({...base,runId:'valid'}));
    const longIds=['a'.repeat(120)+'1','a'.repeat(120)+'2'];
    for (const runId of longIds) await writeFile(join(dir,`${runId}.json`),JSON.stringify({...base,runId}));
    await writeFile(join(dir,'historical.json'),JSON.stringify({...base,runId:'historical',status:'running',plan:{objective:'SENTINEL'},tasks:{T001:{...base.tasks.T001,status:'running'}}}));
    await writeFile(join(dir,'bad.json'),'{SENTINEL');
    await writeFile(join(dir,'large.json'),'SENTINEL'.repeat(700000));
    await mkdir(join(dir,'missing.json'));
    const before=git('status','--porcelain=v1','--untracked-files=all');
    const names=await readdir(dir); const contents=await Promise.all(names.filter(n=>n!=='missing.json').map(n=>readFile(join(dir,n))));
    const output=execFileSync(process.execPath,['--experimental-strip-types',cli,'run-list','--repo',repo],{encoding:'utf8'});
    assert.match(output,/valid: inferred topics: testing, CLI; persisted status: blocked; last recorded activity: 2025-01-02T00:00:00.000Z; blocking reason: decision_needed/);
    assert.match(output,/historical: inferred topics: unavailable; persisted status: running;.*blocking reason: unavailable/);
    const longLines=output.split('\n').filter(line=>longIds.some(id=>line.startsWith(`${id}:`)));
    assert.equal(longLines.length,2, 'long IDs with the same prefix remain distinct and complete');
    for (const id of longIds) assert.ok(longLines.some(line=>line.startsWith(`${id}: inferred topics:`)));
    for (const id of ['bad','large','missing']) assert.match(output,new RegExp(`${id}: unavailable`));
    assert.match(output,/not proof of process liveness/); assert.doesNotMatch(output,/SENTINEL|secret|password/); assert.ok(output.length<2000);
    assert.equal(git('status','--porcelain=v1','--untracked-files=all'),before);
    assert.deepEqual(await readdir(dir),names);
    assert.deepEqual(await Promise.all(names.filter(n=>n!=='missing.json').map(n=>readFile(join(dir,n)))),contents);
  } finally { await rm(repo,{recursive:true,force:true}); }
});
