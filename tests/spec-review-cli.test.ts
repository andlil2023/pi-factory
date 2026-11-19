import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), ...args], { encoding: 'utf8' });
const draft = '# Example\r\n\r\n## What\r\nThing\r\n## Why\r\nReason\r\n## Acceptance criteria\r\n- Works\r\n## Out of scope\r\nNothing\r\n## Threat model\r\nNone\r\n## Open questions\r\nPending\r\n';

async function fixture(replies: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'review-cli-'));
  const spec = join(dir, 'draft.md');
  const config = join(dir, 'config.json');
  const calls = join(dir, 'calls.json');
  const fake = join(dir, 'fake.cjs');
  await writeFile(spec, draft);
  await writeFile(fake, `const fs = require('node:fs');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
 const file = ${JSON.stringify(calls)}; const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
 calls.push({args: process.argv.slice(2), input}); fs.writeFileSync(file, JSON.stringify(calls));
 const text = ${JSON.stringify(replies)}[calls.length - 1];
 console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}}));
});`);
  const model = { provider: 'test', model: 'test' };
  await writeFile(config, JSON.stringify({ agents: { planner: model, implementer: model, reviewer: model }, pi: { executable: process.execPath, executableArgs: [fake] } }));
  return { dir, spec, calls, args: ['spec', 'review', '--repo', dir, '--config', config, '--spec', spec] };
}

test('review prints every finding and leaves the draft unchanged', async () => {
  const findings = [
    { category: 'spec_gap', section: 'What', description: 'Missing choice', question: 'Which one?' },
    { category: 'unverifiable', section: 'Acceptance criteria', description: 'Not measurable', question: 'How to check?' }
  ];
  const f = await fixture([JSON.stringify({ findings })]);
  try {
    const before = await readFile(f.spec);
    const result = cli(...f.args);
    assert.equal(result.status, 0, result.stderr);
    for (const finding of findings) assert.ok(result.stdout.includes(`Category: ${finding.category}\nSection: ${finding.section}\nDescription: ${finding.description}\nQuestion: ${finding.question}`));
    assert.equal(JSON.parse(await readFile(f.calls, 'utf8')).length, 1);
    assert.deepEqual(await readFile(f.spec), before);
    assert.match(cli('--help').stdout, /pi-factory spec review --repo PATH --config FILE --spec FILE/);
    for (const flag of ['--repo', '--config', '--spec']) {
      const index = f.args.indexOf(flag);
      const missing = cli(...f.args.slice(0, index), ...f.args.slice(index + 2));
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, new RegExp(`Missing ${flag}`));
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('review prints an empty report without changing the draft', async () => {
  const f = await fixture(['{"findings":[]}']);
  try {
    const before = await readFile(f.spec);
    const result = cli(...f.args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'No findings.');
    assert.deepEqual(await readFile(f.spec), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('invalid structure reports issues without launching PI', async () => {
  const f = await fixture([]);
  try {
    await writeFile(f.spec, '# Invalid\r\n');
    const before = await readFile(f.spec);
    const result = cli(...f.args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /What: Section is missing/);
    assert.match(result.stderr, /Why: Section is missing/);
    await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
    assert.deepEqual(await readFile(f.spec), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('two invalid replies fail after retry without changing the draft', async () => {
  const f = await fixture(['not json', '{"bad":true}']);
  try {
    const before = await readFile(f.spec);
    const result = cli(...f.args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid spec review reply after retry/);
    const calls = JSON.parse(await readFile(f.calls, 'utf8'));
    assert.equal(calls.length, 2);
    assert.match(calls[1].input, /Validation issues:/);
    assert.deepEqual(await readFile(f.spec), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
