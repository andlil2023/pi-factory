import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const text = '# Example\n\n## What\nSomething\n## Why\nReason\n## Acceptance criteria\n- Works\n## Out of scope\nOther\n## Threat model\nNone\n## Open questions\nNone\n\n';
const plan = { objective: 'Example', assumptions: [], decisions: [], tasks: [{ id: 'T001', title: 'Test', objective: 'Test', scope: 'Test', acceptanceCriteria: ['Works'], dependencies: [], verification: ['test'] }], verification: ['test'] };
const agents = { planner: { provider: 'test', model: 'test' }, implementer: { provider: 'test', model: 'test' }, reviewer: { provider: 'test', model: 'test' } };
const finding = { severity: 'blocking', category: 'other', description: 'Problem', requiredChange: 'Fix it' };

for (const scenario of ['approved', 'verdict', 'finding', 'decision'] as const) test(`start plans and gates final review: ${scenario}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'start-plan-'));
  try {
    const spec = join(dir, 'spec.md'), config = join(dir, 'config.json'), fake = join(dir, 'fake.mjs'), prompts = join(dir, 'prompts');
    const candidate = { ...plan, decisions: scenario === 'decision' ? [{ id: 'D001', question: 'Which choice?', blocking: true, affectedTasks: ['T001'] }] : [] };
    const report = { verdict: scenario === 'verdict' ? 'changes_requested' : 'approved', summary: 'Review summary marker', findings: scenario === 'finding' ? [finding] : [] };
    await writeFile(spec, text);
    await writeFile(fake, `import { appendFileSync } from 'node:fs';\nlet input=''; for await (const c of process.stdin) input+=c;\nconst review=process.argv[process.argv.indexOf('--append-system-prompt')+1].endsWith('plan-reviewer.md');\nappendFileSync(${JSON.stringify(prompts)},JSON.stringify({review,input,args:process.argv})+'\\n');\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(review?${JSON.stringify(report)}:${JSON.stringify(candidate)})}]}}));`);
    await writeFile(config, JSON.stringify({ agents, planning: { maxReviewRounds: 1 }, verification: [{ executable: 'test' }], pi: { executable: process.execPath, executableArgs: [fake] } }));
    const result = spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), 'start', '--repo', dir, '--config', config, '--spec', spec, '--approve'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const calls = (await readFile(prompts, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].review, false);
    assert.equal(calls[1].review, true);
    for (const call of calls) { assert.ok(call.input.includes(text)); assert.ok(!call.args.some((arg: string) => arg.includes(text))); }
    const files = await readdir(join(dir, '.factory', 'plans'));
    assert.equal(files.length, 2);
    const planFile = files.find(file => !file.endsWith('.review.json'))!;
    const reviewFile = files.find(file => file.endsWith('.review.json'))!;
    assert.ok(result.stdout.includes(join(dir, '.factory', 'plans', planFile)));
    assert.ok(result.stdout.includes(join(dir, '.factory', 'plans', reviewFile)));
    assert.deepEqual(JSON.parse(await readFile(join(dir, '.factory', 'plans', reviewFile), 'utf8')), [report]);
    if (scenario === 'approved') assert.match(result.stderr, /git rev-parse failed/i);
    else {
      assert.match(result.stderr, /refused/i);
      assert.match(result.stdout, /Review summary marker/);
      if (scenario === 'decision') assert.match(result.stdout, /Which choice\?/);
      if (scenario === 'finding') assert.match(result.stdout, /Problem/);
    }
    await assert.rejects(readdir(join(dir, '.factory', 'runs')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
