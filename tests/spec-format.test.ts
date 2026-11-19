import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecification, validateSpecification, REQUIRED_SECTIONS } from '../src/spec-format.ts';

const valid = `# Calculator

## What
Subtract numbers.

## Why
Needed by users.

## Acceptance criteria
- Subtraction works.

## Out of scope
Division.

## Threat model
None

## Open questions
None.
`;

test('valid specification exposes its title and optional impact section', () => {
  assert.deepEqual(validateSpecification(valid), []);
  assert.equal(parseSpecification(valid).title, 'Calculator');
  assert.equal(parseSpecification(valid).hasImpactAnalysis, false);
  const extra = valid + '\n## IMPACT ANALYSIS\nEstimate.\n## Notes\nNotes.\n';
  assert.deepEqual(validateSpecification(extra), []);
  assert.equal(parseSpecification(extra).hasImpactAnalysis, true);
});

test('each required section is required, nonempty, unique and case insensitive', () => {
  for (const name of REQUIRED_SECTIONS) {
    const parsed = parseSpecification(valid).sections.find(s => s.heading === name)!;
    const block = `## ${name}\n${parsed.body}`;
    assert.ok(validateSpecification(valid.replace(block, '')).some(i => i.section === name && /missing/.test(i.message)));
    assert.ok(validateSpecification(valid.replace(block, `## ${name}\n`)).some(i => i.section === name && /empty/.test(i.message)));
    assert.ok(validateSpecification(valid + `\n## ${name.toUpperCase()}\nAgain\n`).some(i => i.section === name && /more than once/.test(i.message)));
    assert.deepEqual(validateSpecification(valid.replace(`## ${name}`, `## ${name.toUpperCase()}`)), []);
  }
});

test('title is unique and nonempty', () => {
  for (const text of [valid.replace('# Calculator\n', ''), valid.replace('# Calculator', '# '), '# Other\n' + valid]) {
    assert.ok(validateSpecification(text).some(i => i.section === 'Title'));
  }
});

test('criteria require a list item and readiness can be waived without waiving structure', () => {
  assert.ok(validateSpecification(valid.replace('- Subtraction works.', 'Works.')).some(i => i.section === 'Acceptance criteria'));
  const unresolved = valid.replace('None.\n', 'Needs a decision.\n');
  assert.equal(validateSpecification(unresolved).at(-1)?.section, 'Open questions');
  assert.deepEqual(validateSpecification(unresolved, { allowOpenQuestions: true }), []);
  assert.ok(validateSpecification(valid.replace('None.\n', ''), { allowOpenQuestions: true }).some(i => i.section === 'Open questions'));
  assert.deepEqual(validateSpecification(valid.replace('None.', 'nOnE')), []);
});

test('fenced headings and list items are not syntax; CRLF is equivalent', () => {
  const fenced = valid.replace('Subtract numbers.', 'Subtract numbers.\n```md\n# Another\n## Why\n~~~\n```');
  assert.deepEqual(validateSpecification(fenced), []);
  assert.deepEqual(validateSpecification(fenced.replaceAll('\n', '\r\n')), validateSpecification(fenced));
  const fakeList = valid.replace('- Subtraction works.', '```\n- Not a criterion\n```');
  assert.ok(validateSpecification(fakeList).some(i => i.section === 'Acceptance criteria'));
});
