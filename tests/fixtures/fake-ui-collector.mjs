// Simulates a trusted desktop test harness without launching an app.
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
const dir = process.env.FACTORY_UI_EVIDENCE_DIRECTORY;
const mode = process.argv[2] ?? 'passed';
if (mode === 'nonzero') process.exit(7);
if (mode === 'missing-manifest') process.exit(0);
if (mode === 'malformed') {
  await writeFile(join(dir, 'manifest.json'), '{}');
  process.exit(0);
}
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
await writeFile(join(dir, 'window.png'), mode === 'invalid-image' ? 'not an image' : image);
await writeFile(join(dir, 'tree.json'), JSON.stringify({ controlType: 'Window', automationId: 'MainWindow' }));
const manifest = {
  version: 1,
  taskId: process.env.FACTORY_TASK_ID,
  attempt: Number(process.env.FACTORY_ATTEMPT),
  capturedAt: new Date().toISOString(),
  sourceFingerprint: process.env.FACTORY_SOURCE_FINGERPRINT,
  application: { framework: 'wpf', buildId: 'fake-build-1' },
  checks: [
    { kind: 'interaction', name: 'Keyboard navigation', status: 'passed' },
    { kind: 'accessibility', name: 'Accessible names', status: 'passed' }
  ],
  artifacts: [ { kind: 'screenshot', path: 'window.png' }, { kind: 'accessibility-tree', path: 'tree.json' } ],
  limitations: ['Fixture only; not real WPF evidence']
};
if (mode === 'wrong-task') manifest.taskId = 'T999';
if (mode === 'wrong-attempt') manifest.attempt++;
if (mode === 'stale') manifest.capturedAt = '2000-01-01T00:00:00Z';
if (mode === 'fingerprint') manifest.sourceFingerprint = '0'.repeat(64);
if (mode === 'failed-check') manifest.checks[0].status = 'failed';
if (mode === 'missing-check') manifest.checks.pop();
if (mode === 'missing-artifact') manifest.artifacts.pop();
if (mode === 'missing-file') manifest.artifacts[0].path = 'absent.png';
if (mode === 'traversal') manifest.artifacts[0].path = '../outside.png';
if (mode === 'absolute') manifest.artifacts[0].path = join(dir, 'window.png');
if (mode === 'duplicate') manifest.artifacts.push({ kind: 'log', path: 'tree.json' });
if (mode === 'symlink') {
  const outside = join(dir, '..', 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'tree.json'), '{}');
  await symlink(outside, join(dir, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  manifest.artifacts[1].path = 'outside-link/tree.json';
}
if (mode === 'source-mutation') await writeFile('source.txt', 'mutated by collector');
await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
