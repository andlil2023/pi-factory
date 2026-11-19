import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { reviewSpecification } from '../src/spec-review.ts';

const draft = '# Example\r\n\r\n## What\r\nThing\r\n## Why\r\nReason\r\n## Acceptance criteria\r\n- Works\r\n## Out of scope\r\nNothing\r\n## Threat model\r\nNone\r\n## Open questions\r\nPending\r\n';
const report = { findings: [{ category: 'spec_gap', section: 'What', description: 'Missing decision', question: 'Which option?' }] };
const reviewer = { provider: 'base-provider', model: 'base' };
const planReviewer = { provider: 'plan-provider', model: 'plan' };
const specReviewer = { provider: 'spec-provider', model: 'spec' };

async function fixture(replies: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'spec-review-'));
  const specFile = join(dir, 'draft.md');
  const calls = join(dir, 'calls.json');
  const fake = join(dir, 'fake.cjs');
  await writeFile(specFile, draft);
  await writeFile(fake, `const fs = require('node:fs');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
 const file = ${JSON.stringify(calls)}; const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
 calls.push({ args: process.argv.slice(2), input }); fs.writeFileSync(file, JSON.stringify(calls));
 const text = ${JSON.stringify(replies)}[calls.length - 1];
 console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text',text}]}}));
});`);
  return { dir, specFile, calls, options: { repository: dir, specFile, factoryRoot: resolve('.'), agents: { reviewer },
    config: { verification: [{ executable: 'npm', args: ['test'] }], uiEvidence: {} },
    pi: { executable: process.execPath, executableArgs: [fake] } } };
}

test('invalid structure reports issues without starting PI or changing the draft', async () => {
  const f = await fixture([]);
  try {
    await writeFile(f.specFile, '# Invalid\r\n');
    const before = await readFile(f.specFile);
    await assert.rejects(reviewSpecification(f.options), /What: Section is missing/);
    await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
    assert.deepEqual(await readFile(f.specFile), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('valid draft uses configured reviewer, read-only fresh session and verification context', async () => {
  const f = await fixture([JSON.stringify(report)]);
  try {
    const before = await readFile(f.specFile);
    assert.deepEqual(await reviewSpecification({ ...f.options, agents: { reviewer, planReviewer, specReviewer } }), report);
    const calls = JSON.parse(await readFile(f.calls, 'utf8'));
    assert.equal(calls.length, 1);
    const args = calls[0].args as string[];
    assert.ok(args.includes('--no-session'));
    assert.equal(args[args.indexOf('--provider') + 1], 'spec-provider');
    assert.equal(args[args.indexOf('--model') + 1], 'spec');
    assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /spec-reviewer\.md$/);
    assert.ok(calls[0].input.includes(draft));
    assert.match(calls[0].input, /npm test/);
    assert.match(calls[0].input, /rendered UI evidence collector is configured/);
    assert.doesNotMatch(calls[0].input, /interview history/i);
    assert.deepEqual(await readFile(f.specFile), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('invalid contract reply retries freshly with issues and plan reviewer fallback', async () => {
  const f = await fixture(['{"findings":[{"category":"other"}]}', '{"findings":[]}']);
  try {
    const before = await readFile(f.specFile);
    assert.deepEqual(await reviewSpecification({ ...f.options, agents: { reviewer, planReviewer } }), { findings: [] });
    const calls = JSON.parse(await readFile(f.calls, 'utf8'));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(call.args.includes('--no-session'));
      assert.equal(call.args[call.args.indexOf('--model') + 1], 'plan');
    }
    assert.match(calls[1].input, /"category":"other"/);
    assert.match(calls[1].input, /Validation issues:/);
    assert.deepEqual(await readFile(f.specFile), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('two invalid replies fail without writing the draft and use reviewer fallback', async () => {
  const f = await fixture(['not json', '{"bad":true}']);
  try {
    const before = await readFile(f.specFile);
    await assert.rejects(reviewSpecification(f.options), /Invalid spec review reply after retry/);
    assert.deepEqual(await readFile(f.specFile), before);
    const calls = JSON.parse(await readFile(f.calls, 'utf8'));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'base');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
