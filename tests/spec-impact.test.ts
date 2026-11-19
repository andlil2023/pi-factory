import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeImpact } from '../src/spec-impact.ts';

const draft = '# Example\n\n## What\nThing\n## Why\nReason\n## Acceptance criteria\n- Works\n## Out of scope\nNothing\n## Threat model\nNone\n## Open questions\nPending\n';
const good = JSON.stringify({ affectedModules: [{ path: 'does-not-exist/file.ts', change: 'May change behavior.' }], consequences: ['Users may notice changes.'] });
const agents = { planner: { provider: 'fallback-provider', model: 'fallback-model' } };

async function fixture(replies: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'impact-'));
  const specFile = join(dir, 'draft.md');
  const calls = join(dir, 'calls.json');
  const fake = join(dir, 'fake.cjs');
  await writeFile(specFile, draft);
  await writeFile(fake, `const fs = require('node:fs');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
 const file = ${JSON.stringify(calls)}; const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
 calls.push({ args: process.argv.slice(2), input }); fs.writeFileSync(file, JSON.stringify(calls));
 const replies = ${JSON.stringify(replies)}; const text = replies[calls.length - 1];
 console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text',text}]}}));
});`);
  const options = { repository: dir, specFile, factoryRoot: resolve('.'), agents, pi: { executable: process.execPath, executableArgs: [fake] } };
  return { dir, specFile, calls, options };
}

test('invalid draft reports structural issues without starting PI', async () => {
  const f = await fixture([good]);
  try {
    await writeFile(f.specFile, '# Invalid\n');
    await assert.rejects(analyzeImpact(f.options), /What: Section is missing/);
    await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('open questions allowed, configured model and read-only tools used, nonexistent paths rendered as text', async () => {
  const f = await fixture([good]);
  try {
    await analyzeImpact({ ...f.options, agents: { ...agents, impactAnalyst: { provider: 'analyst-provider', model: 'analyst-model' } } });
    const calls = JSON.parse(await readFile(f.calls, 'utf8'));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 7), ['--print', '--mode', 'json', '--no-session', '--provider', 'analyst-provider', '--model']);
    assert.equal(calls[0].args[7], 'analyst-model');
    assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], 'read,grep,find,ls');
    assert.match(await readFile(f.specFile, 'utf8'), /`does-not-exist\/file.ts`: May change behavior\./);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('invalid reply retries in a fresh session with reply and issues, using planner fallback', async () => {
  const f = await fixture(['{"bad":true}', good]);
  try {
    await analyzeImpact(f.options);
    const calls = JSON.parse(await readFile(f.calls, 'utf8'));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'fallback-model');
    assert.match(calls[1].input, /\{"bad":true\}/);
    assert.match(calls[1].input, /Validation issues:/);
    assert.match(await readFile(f.specFile, 'utf8'), /## Impact analysis/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('two invalid replies fail without changing any draft bytes', async () => {
  const f = await fixture(['not json', '{"bad":true}']);
  try {
    const before = await readFile(f.specFile);
    await assert.rejects(analyzeImpact(f.options), /Invalid impact reply after retry/);
    assert.deepEqual(await readFile(f.specFile), before);
    assert.equal(JSON.parse(await readFile(f.calls, 'utf8')).length, 2);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
