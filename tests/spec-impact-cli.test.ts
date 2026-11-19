import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/factory-cli.ts'), ...args], { encoding: 'utf8' });
const draft = '# Example\n\n## What\nThing\n## Why\nReason\n## Acceptance criteria\n- Works\n## Out of scope\nNothing\n## Threat model\nNone\n## Open questions\nPending\n';
const good = JSON.stringify({ affectedModules: [{ path: 'src/example.ts', change: 'Behavior may change.' }], consequences: ['Users may notice changes.'] });

async function fixture(replies: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'impact-cli-'));
  const spec = join(dir, 'draft.md');
  const config = join(dir, 'config.json');
  const calls = join(dir, 'calls.json');
  const fake = join(dir, 'fake.cjs');
  await writeFile(spec, draft);
  await writeFile(fake, `const fs = require('node:fs');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
 const file = ${JSON.stringify(calls)}; const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
 calls.push({ args: process.argv.slice(2), input }); fs.writeFileSync(file, JSON.stringify(calls));
 const text = ${JSON.stringify(replies)}[calls.length - 1];
 console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text',text}]}}));
});`);
  const model = { provider: 'test', model: 'test' };
  await writeFile(config, JSON.stringify({ agents: { planner: model, implementer: model, reviewer: model }, pi: { executable: process.execPath, executableArgs: [fake] } }));
  return { dir, spec, config, calls, args: ['spec', 'impact', '--repo', dir, '--config', config, '--spec', spec] };
}

test('spec impact writes a valid estimate and preserves existing command routing', async () => {
  const f = await fixture([good]);
  try {
    const result = cli(...f.args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Impact analysis written/);
    assert.match(await readFile(f.spec, 'utf8'), /`src\/example\.ts`: Behavior may change\./);
    assert.equal(JSON.parse(await readFile(f.calls, 'utf8')).length, 1);
    const check = cli('spec', 'check', '--spec', f.spec);
    assert.equal(check.status, 1); // Open questions remain unresolved for check.
    assert.match(check.stdout, /Open questions:/);
    const unknown = cli('spec', 'unknown');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown spec command/);
    const help = cli('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /pi-factory spec impact --repo PATH --config FILE --spec FILE/);
    for (const flag of ['--repo', '--config', '--spec']) {
      const index = f.args.indexOf(flag);
      const missing = cli(...f.args.slice(0, index), ...f.args.slice(index + 2));
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, new RegExp(`Missing ${flag}`));
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('spec impact reports failed retry without modifying the draft', async () => {
  const f = await fixture(['not json', '{"bad":true}']);
  try {
    const before = await readFile(f.spec);
    const result = cli(...f.args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid impact reply after retry/);
    assert.deepEqual(await readFile(f.spec), before);
    const calls = JSON.parse(await readFile(f.calls, 'utf8'));
    assert.equal(calls.length, 2);
    assert.match(calls[1].input, /Validation issues:/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
