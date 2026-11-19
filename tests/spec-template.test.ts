import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { initialize } from '../src/init.ts';
import { validateSpecification } from '../src/spec-format.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const templatePath = join(root, 'templates', 'specification.md');

test('template has the design title and sections and is structurally valid', async () => {
  const template = await readFile(templatePath, 'utf8');
  assert.match(template, /^# <Title>\r?\n/);
  assert.deepEqual([...template.matchAll(/^## (.+)$/gm)].map(match => match[1].trim()), [
    'What', 'Why', 'Acceptance criteria', 'Out of scope', 'Threat model', 'Open questions', 'Impact analysis',
  ]);
  assert.match(template, /^## Open questions\r?\nNone\r?$/m);
  assert.match(template, /^### Likely affected areas\r?$/m);
  assert.match(template, /^### Likely consequences\r?$/m);
  assert.deepEqual(validateSpecification(template), []);
});

test('init copies the template, keeps edits, and replaces them when forced', async () => {
  const target = await mkdtemp(join(tmpdir(), 'pi-factory-template-'));
  try {
    const destination = join(target, '.factory', 'specification-template.md');
    const template = await readFile(templatePath, 'utf8');
    await initialize(target);
    assert.equal(await readFile(destination, 'utf8'), template);
    assert.ok(await readFile(join(target, '.factory', 'objective.md'), 'utf8'));
    await writeFile(destination, 'custom template');
    await initialize(target);
    assert.equal(await readFile(destination, 'utf8'), 'custom template');
    await initialize(target, true);
    assert.equal(await readFile(destination, 'utf8'), template);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
