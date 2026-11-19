import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMPACT_ESTIMATE_LINE, renderImpact } from '../src/spec-impact.ts';
import { parseSpecification, replaceSection } from '../src/spec-format.ts';

const report = { affectedModules: [{ path: 'src/a.ts', change: 'New command.' }], consequences: ['Config gains a key.'] };
const body = `${IMPACT_ESTIMATE_LINE}\n\n### Likely affected areas\n- \`src/a.ts\`: New command.\n\n### Likely consequences\n- Config gains a key.`;

test('renders the fixed estimate and one line per entry', () => {
  assert.equal(renderImpact(report), body);
  assert.equal(renderImpact({ affectedModules: [], consequences: [] }), `${IMPACT_ESTIMATE_LINE}\n\n### Likely affected areas\n- None identified.\n\n### Likely consequences\n- None identified.`);
  assert.match(renderImpact({ affectedModules: [{ path: 'src/a', change: 'One\n  line.' }], consequences: ['Another\r\n line.'] }), /- `src\/a`: One line\.\n\n### Likely consequences\n- Another line\./);
});

test('replaces a section without altering surrounding text, including CRLF', () => {
  for (const nl of ['\n', '\r\n']) {
    const before = ['# Title', '', '## What', 'Keep this.', '', ''].join(nl);
    const after = ['## Notes', 'Keep these too.', ''].join(nl);
    const old = ['## IMPACT ANALYSIS  ', 'Old estimate.', '', ''].join(nl);
    const expected = before + '## IMPACT ANALYSIS  ' + nl + body.replaceAll('\n', nl) + nl + nl + after;
    assert.equal(replaceSection(before + old + after, 'Impact analysis', body), expected);
  }
});

test('appends a missing section and recognizes fenced headings as text', () => {
  const original = '# Title\n\n## What\n```md\n## Impact analysis\nFake\n```\n~~~\n## Impact analysis\nFake again\n~~~\n';
  assert.equal(replaceSection(original, 'Impact analysis', body), original + '\n## Impact analysis\n' + body + '\n');
  assert.equal(replaceSection('# Title\r\n', 'Impact analysis', body), '# Title\r\n\r\n## Impact analysis\r\n' + body.replaceAll('\n', '\r\n') + '\r\n');
});

test('inserts outside an unterminated fence without changing surrounding content', () => {
  for (const nl of ['\n', '\r\n']) {
    for (const marker of ['```md', '~~~']) {
      const before = ['# Title', '', '## What', 'Keep this.', '', ''].join(nl);
      const after = ['## Notes', marker, 'Example', '## Impact analysis', 'Still fenced', ''].join(nl);
      const result = replaceSection(before + after, 'Impact analysis', body);
      const inserted = `## Impact analysis${nl}${body.replaceAll('\n', nl)}${nl}${nl}`;
      assert.equal(result, before + inserted + after);
      const parsed = parseSpecification(result);
      assert.equal(parsed.hasImpactAnalysis, true);
      assert.equal(parsed.sections.filter(section => section.heading === 'Impact analysis').length, 1);
    }
  }
  const noSection = '# Title\n```\nExample\n';
  const result = replaceSection(noSection, 'Impact analysis', body);
  assert.equal(result, `## Impact analysis\n${body}\n\n${noSection}`);
  assert.equal(parseSpecification(result).hasImpactAnalysis, true);
});

test('removes duplicate real sections and preserves intervening sections', () => {
  const draft = '# Title\n## Impact analysis\nOld\n\n## Notes\nKeep\n\n## Impact analysis\nOld again\n## End\nKeep.\n';
  assert.equal(replaceSection(draft, 'Impact analysis', body), '# Title\n## Impact analysis\n' + body + '\n\n## Notes\nKeep\n\n## End\nKeep.\n');
});
