import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli=resolve('src/factory-cli.ts');
test('doctor inspects configuration and tools without executing configured commands or leaking secrets', async () => {
  const dir=await mkdtemp(join(tmpdir(),'factory-doctor-'));
  const marker=join(dir,'invoked');
  const fixture=join(dir,process.platform==='win32' ? 'fixture.cmd' : 'fixture');
  await writeFile(fixture,process.platform==='win32' ? `@echo invoked > "${marker}"\r\n` : `#!/bin/sh\necho invoked > "${marker}"\n`);
  await chmod(fixture,0o755);
  const config=join(dir,'config.json');
  const base={agents:{planner:{},implementer:{},reviewer:{}},pi:{executable:fixture},setup:[{executable:fixture,args:['SECRET_SETUP']}],verification:[{executable:fixture,args:['SECRET_VERIFY']}]};
  const run=(path:string, env:NodeJS.ProcessEnv=process.env) => spawnSync(process.execPath,['--experimental-strip-types',cli,'doctor','--config',path],{encoding:'utf8',env});
  await writeFile(config,JSON.stringify(base));
  const valid=run(config);
  assert.equal(valid.status,0,valid.stderr);
  assert.match(valid.stdout,/Blockers:\s*- none/);
  assert.match(valid.stdout,/Warnings:\s*- none/);
  assert.doesNotMatch(valid.stdout+valid.stderr,/SECRET_|invoked|fixture/);
  await assert.rejects(access(marker));
  for (const verification of [undefined, []]) {
    await writeFile(config,JSON.stringify({...base,verification}));
    const noVerification=run(config);
    assert.equal(noVerification.status,1);
    assert.match(noVerification.stdout,/Blockers:[\s\S]*Verification: configure at least one trusted verification command/);
    assert.doesNotMatch(noVerification.stdout+noVerification.stderr,/SECRET_|fixture/);
  }
  await writeFile(config,JSON.stringify({...base,pi:{executable:join(dir,'missing-secret')},verification:[{executable:join(dir,'optional-secret')}]}));
  const missing=run(config);
  assert.equal(missing.status,1);
  assert.match(missing.stdout,/Pi: install/);
  assert.match(missing.stdout,/Verification: a configured executable/);
  assert.doesNotMatch(missing.stdout+missing.stderr,/secret/i);
  await writeFile(config,JSON.stringify({...base,verification:[{executable:join(dir,'missing-secret')},{executable:join(dir,'also-missing-secret')},{executable:123},{executable:fixture,args:[123]}]}));
  const mixed=run(config);
  assert.equal(mixed.status,1);
  assert.match(mixed.stdout,/Verification: configure valid executable, args and timeout values/);
  assert.equal((mixed.stdout.match(/Verification: a configured executable/g) ?? []).length,1);
  assert.doesNotMatch(mixed.stdout+mixed.stderr,/secret|fixture/i);
  await assert.rejects(access(marker));
  for (const verification of [[{executable:fixture,name:'bad name'}], [{executable:fixture,name:'same'},{executable:fixture,name:'same'}]]) {
    await writeFile(config,JSON.stringify({...base,verification}));
    const invalidNames=run(config);
    assert.equal(invalidNames.status,1);
    assert.match(invalidNames.stdout,/Verification: configure valid, unique check names/);
    assert.doesNotMatch(invalidNames.stdout+invalidNames.stderr,/fixture|SECRET_/);
  }
  await assert.rejects(access(marker));
  await writeFile(config,'{"SECRET_INVALID":');
  const invalid=run(config);
  assert.equal(invalid.status,1);
  assert.match(invalid.stdout,/Configuration:/);
  assert.doesNotMatch(invalid.stdout+invalid.stderr,/SECRET_INVALID/);
  const noGit=run(config,{...process.env,PATH:dirname(fixture)});
  assert.match(noGit.stdout,/Git: install/);
});
