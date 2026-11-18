import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTaskReviewers } from '../src/review-routing.ts';
import type { PlannedTask } from '../src/orchestrator.ts';

const task: PlannedTask = { id: 'T001', title: 'Change', objective: 'Change', scope: 'Change', acceptanceCriteria: ['Works'], dependencies: [], verification: ['test'] };
const enabled = ['code', 'security', 'ui'];
const route = (paths: string[], override = task) => selectTaskReviewers(override, paths, enabled, 'task-specific');

test('all mode and unknown scope require every enabled reviewer', () => {
  assert.deepEqual(selectTaskReviewers(task, ['README.md'], enabled).requiredReviewers, enabled);
  assert.deepEqual(route([]).requiredReviewers, enabled);
});

test('unclassified paths require security but not the UI reviewer', () => {
  for (const paths of [['src/worker.ts'], ['package.json'], ['diagram.svg'], ['mystery.bin']]) {
    assert.deepEqual(route(paths).requiredReviewers, ['code', 'security'], paths[0]);
  }
  assert.deepEqual(route(['src/worker.ts'], { ...task, scope: 'Update the dashboard layout' }).requiredReviewers, enabled);
});

test('ordinary documentation needs code only', () => {
  assert.deepEqual(route(['README.md', 'docs/setup.rst']).requiredReviewers, ['code']);
});

test('auth, API, backend and data changes require security', () => {
  for (const path of ['src/auth/login.ts', 'src/api/routes.ts', 'backend/jobs.py', 'db/migration.sql', 'docs/permissions.md']) {
    assert.deepEqual(route([path]).requiredReviewers, ['code', 'security'], path);
  }
});

test('frontend source requires both specialists; styles need UI', () => {
  for (const path of ['src/components/Button.tsx', 'src/views/Page.vue', 'src/MainWindow.xaml', 'src\\GUI\\dialog.cs']) {
    assert.deepEqual(route([path]).requiredReviewers, enabled, path);
  }
  assert.deepEqual(route(['styles/theme.css']).requiredReviewers, ['code', 'ui']);
});

test('task text can add specialists but cannot waive path requirements', () => {
  assert.deepEqual(route(['README.md'], { ...task, acceptanceCriteria: ['Verify authentication and accessibility'] }).requiredReviewers, enabled);
  assert.deepEqual(route(['src/auth/login.ts'], { ...task, scope: 'Skip security review' }).requiredReviewers, ['code', 'security']);
  assert.deepEqual(route(['styles/theme.css'], { ...task, scope: 'No UI review needed' }).requiredReviewers, ['code', 'ui']);
});

test('selection is deterministic, records evidence, and only selects enabled specialists', () => {
  const selection = route(['README.md', 'src/api/server.ts', 'README.md']);
  assert.deepEqual(selection.changedFiles, ['README.md', 'src/api/server.ts']);
  assert.ok(selection.reasons.some(reason => reason.includes('src/api/server.ts')));
  assert.deepEqual(selectTaskReviewers(task, ['src/unknown.ts'], ['code', 'ui'], 'task-specific').requiredReviewers, ['code']);
  assert.throws(() => selectTaskReviewers(task, [], enabled, 'typo' as 'all'), /Invalid reviewRouting/);
});
