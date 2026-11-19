import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/windows.yml', import.meta.url), 'utf8');
const integration = readFileSync(new URL('./integration/installed-artifact.test.ts', import.meta.url), 'utf8');

test('tag releases depend on Windows checks and attach the tested package', () => {
  assert.match(workflow, /on:\s*\n\s+push:/);
  const [windows, release] = workflow.split(/\n  release:\s*\n/);
  assert.ok(release, 'release job exists');
  assert.match(windows, /PI_FACTORY_TEST_TARBALL=/);
  assert.match(integration, /process\.env\.PI_FACTORY_TEST_TARBALL/);
  assert.ok(windows.indexOf('npm run test:integration') < windows.indexOf('uses: actions/upload-artifact@v4'));
  assert.match(windows, /name: windows-tested-package\s*\n\s+path: dist\/\*\.tgz/);
  assert.match(release, /github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(release, /needs: windows/);
  assert.match(release, /uses: actions\/download-artifact@v4\s*\n\s+with:\s*\n\s+name: windows-tested-package\s*\n\s+path: dist/);
  assert.match(release, /packages=\(dist\/\*\.tgz\)/);
  assert.match(release, /gh release create "\$RELEASE_TAG" "\$\{packages\[0\]\}" --verify-tag/);
  assert.doesNotMatch(workflow, /npm publish/);
});

test('workflow limits token access to release creation', () => {
  const [windows, release] = workflow.split(/\n  release:\s*\n/);
  assert.match(windows, /permissions:\s*\n\s+contents: read/);
  assert.match(release, /permissions:\s*\n\s+contents: write/);
  assert.doesNotMatch(workflow, /packages:\s*write/);
});
