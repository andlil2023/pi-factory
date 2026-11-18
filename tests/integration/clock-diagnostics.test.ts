import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const summarize = 'tests/fixtures/clock-summarize.cjs';
test('clock summary recomputes elapsed correction from brackets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clock-test-'));
  try {
    const file = join(dir, 'input.json');
    writeFileSync(file, JSON.stringify({ rows: [{ before: { a: '0', b: '2000000', w: 100 }, child: { a: '4000000', b: '6000000', w: 107 }, after: { a: '7000000', b: '8000000', w: 108 } }] }));
    const result = JSON.parse(execFileSync(process.execPath, [summarize, file], { encoding: 'utf8' }));
    assert.equal(result.count, 1);
    assert.equal(result.minMs, 3);
    assert.equal(result.maxMs, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const mode of ['ipc', 'worker']) test(`${mode} clock probe records 1000 exchanges`, () => {
  const output = execFileSync(process.execPath, ['tests/fixtures/clock-exchanges.cjs', mode], { encoding: 'utf8', maxBuffer: 2_000_000 });
  const result = JSON.parse(output);
  assert.equal(result.mode, mode);
  assert.equal(result.rows.length, 1000);
  assert.ok(result.rows.every((row: { before: { a: string; b: string }; child: { a: string; b: string }; after: { a: string; b: string } }) => [row.before, row.child, row.after].every(sample => BigInt(sample.a) <= BigInt(sample.b))));
});
