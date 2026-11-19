import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const body = '## What\nSomething\n## Why\nReason\n## Acceptance criteria\n- Works\n## Out of scope\nOther\n## Threat model\nNone\n## Open questions\nNone\n\n';
const text = `# Example\n\n${body}`;
const plan = { objective: 'Example', assumptions: [], decisions: [], tasks: [{ id: 'T001', title: 'Test', objective: 'Test', scope: 'Test', acceptanceCriteria: ['Works'], dependencies: [], verification: ['test'] }], verification: ['test'] };
const agents = { planner: { provider: 'test', model: 'test' }, implementer: { provider: 'test', model: 'test' }, reviewer: { provider: 'test', model: 'test' } };

for (const kind of ['local', 'github'] as const) test(`clean ${kind} start executes and persists the fetched specification`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'start-execution-'));
  try {
    const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    await writeFile(join(dir, '.gitignore'), '*\n!.gitignore\n'); git('add', '.gitignore'); git('commit', '-m', 'initial');
    const fake = join(dir, 'fake.mjs'), config = join(dir, 'config.json'), calls = join(dir, 'calls'), setup = join(dir, 'setup');
    await writeFile(fake, `import { appendFileSync } from 'node:fs';\nlet input=''; for await (const c of process.stdin) input+=c;\nconst role=process.argv[process.argv.indexOf('--append-system-prompt')+1];\nappendFileSync(${JSON.stringify(calls)},JSON.stringify({role,input,args:process.argv})+'\\n');\nconst result=role.endsWith('plan-reviewer.md')?{verdict:'approved',summary:'clean',findings:[]}:role.endsWith('planner.md')?${JSON.stringify(plan)}:{taskId:'T001',outcome:'blocked',summary:'Need guidance',filesChanged:[],verification:[],blockers:[{kind:'decision_needed',description:'Need guidance',question:'What next?'}]};\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(result)}]}}));`);
    const specifications = kind === 'github' ? { store: 'github', github: { repository: 'owner/repo', project: { owner: 'owner', number: 1 } } } : undefined;
    await writeFile(config, JSON.stringify({ agents, specifications, planning: { maxReviewRounds: 1 }, execution: { maxAutoReplans: 0 }, verification: [{ executable: process.execPath, args: ['--version'] }], setup: [{ executable: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(setup)},process.cwd())`] }], pi: { executable: process.execPath, executableArgs: [fake] } }));
    const spec = kind === 'local' ? 'spec.md' : '42';
    const ghCalls = join(dir, 'gh-calls');
    if (kind === 'local') await writeFile(join(dir, spec), text);
    else {
      const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
      const issue = { title: 'Example', body, url: 'https://github.com/owner/repo/issues/42', updatedAt: '2025-01-01T00:00:00Z' };
      const state = { state: 'OPEN', labels: connection([{ name: 'factory-spec' }]), projectItems: connection([{ project: { number: 1, owner: { login: 'owner' } }, fieldValueByName: { __typename: 'ProjectV2ItemFieldIterationValue', title: 'Current', startDate: '2020-01-01', duration: 100000 } }]) };
      await writeFile(join(dir, 'issue'), `require('fs').appendFileSync(${JSON.stringify(ghCalls)},'fetch\\n'); console.log(JSON.stringify(${JSON.stringify(issue)}));`);
      await writeFile(join(dir, 'api'), `require('fs').appendFileSync(${JSON.stringify(ghCalls)},'startable\\n'); console.log(JSON.stringify(${JSON.stringify({ data: { repository: { issue: state } } })}));`);
      if (process.platform === 'win32') await copyFile(process.execPath, join(dir, 'gh.exe'));
      else { await writeFile(join(dir, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`); await chmod(join(dir, 'gh'), 0o755); }
    }
    const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` };
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
    const hash = createHash('sha256').update(text).digest('hex');
    const before = Date.now();
    const result = cli('start', '--repo', dir, '--config', config, '--spec', spec, '--approve', ...(kind === 'github' ? ['--sha256', hash] : []));
    assert.match(result.stdout, /Created run worktree:/, result.stderr);
    const files = await readdir(join(dir, '.factory', 'runs'));
    const stateFile = files.find(f => /^run-.*\.json$/.test(f) && !f.endsWith('.events.jsonl'))!;
    assert.ok(stateFile, result.stderr);
    const state = JSON.parse(await readFile(join(dir, '.factory', 'runs', stateFile), 'utf8'));
    assert.equal(state.specification.store, kind); assert.equal(state.specification.id, spec);
    assert.equal(state.specification.text, text); assert.equal(state.specification.sha256, hash);
    assert.equal(state.specification.url, kind === 'github' ? 'https://github.com/owner/repo/issues/42' : undefined);
    assert.ok(Date.parse(state.specification.fetchedAt) >= before && Date.parse(state.specification.fetchedAt) <= Date.now());
    assert.equal(await readFile(setup, 'utf8'), state.git.worktree);
    assert.ok(state.tasks.T001.attempts.length > 0);
    const prompts = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(prompts[0].input.includes(text)); assert.ok(!prompts.some(call => call.args.some((arg: string) => arg.includes(text))));
    if (kind === 'local') await rm(join(dir, spec)); else await rm(join(dir, 'gh.exe'), { force: true });
    const ghBefore = kind === 'github' ? await readFile(ghCalls, 'utf8') : '';
    const resumed = cli('resume', '--repo', dir, '--config', config, '--run', state.runId, '--retry-task', 'T001', '--approve');
    assert.match(resumed.stdout, /Run .*worktree:/, resumed.stderr);
    const afterResume = JSON.parse(await readFile(join(dir, '.factory', 'runs', stateFile), 'utf8'));
    assert.ok(afterResume.tasks.T001.attempts.length > state.tasks.T001.attempts.length);
    const help = cli('help');
    assert.equal(help.status, 0); assert.match(help.stdout, /pi-factory start --repo/);
    const status = cli('status', '--repo', dir, '--run', state.runId);
    assert.equal(status.status, 0, status.stderr);
    if (kind === 'github') assert.equal(await readFile(ghCalls, 'utf8'), ghBefore);
    assert.deepEqual(JSON.parse(await readFile(join(dir, '.factory', 'runs', stateFile), 'utf8')).specification, state.specification);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
