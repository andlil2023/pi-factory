import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli=resolve('src/factory-cli.ts');

test('doctor checks gh only for the GitHub store without running it', async () => {
  const dir=await mkdtemp(join(tmpdir(),'factory-doctor-gh-'));
  const marker=join(dir,'gh-invoked');
  const extension=process.platform==='win32' ? '.cmd' : '';
  const fake=async (name:string, contents:string) => {
    const path=join(dir,name+extension);
    await writeFile(path,contents);
    await chmod(path,0o755);
  };
  await fake('git',process.platform==='win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  const config=join(dir,'config.json');
  const base={agents:{planner:{},implementer:{},reviewer:{}},pi:{executable:process.execPath},verification:[{executable:process.execPath}]};
  const run=async (specifications?:object) => {
    await writeFile(config,JSON.stringify({...base,specifications}));
    return spawnSync(process.execPath,['--experimental-strip-types',cli,'doctor','--config',config],{encoding:'utf8',env:{...process.env,PATH:dir}});
  };
  const github={store:'github',github:{project:{owner:'example',number:1}}};
  const missing=await run(github);
  assert.equal(missing.status,1,missing.stderr);
  assert.match(missing.stdout,/Blockers:[\s\S]*install gh/i);
  for (const local of [undefined,{store:'local'},{github:{project:{owner:'example',number:1}}}]) {
    const result=await run(local);
    assert.equal(result.status,0,result.stderr);
    assert.doesNotMatch(result.stdout,/install gh/i);
  }
  await fake('gh',process.platform==='win32' ? `@echo invoked > "${marker}"\r\n` : `#!/bin/sh\necho invoked > "${marker}"\n`);
  const available=await run(github);
  assert.equal(available.status,0,available.stderr);
  assert.doesNotMatch(available.stdout,/install gh/i);
  await assert.rejects(access(marker));
});
