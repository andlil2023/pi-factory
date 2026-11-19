import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('optional skills use supported installed CLI inspection and planning syntax', () => {
  const help = spawnSync(process.execPath, ['bin/pi-factory.js', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const start = readFileSync(new URL('../.pi/skills/factory-start/SKILL.md', import.meta.url), 'utf8');
  const status = readFileSync(new URL('../.pi/skills/factory-status/SKILL.md', import.meta.url), 'utf8');
  for (const command of [
    'pi-factory plan --repo PATH --config FILE --objective FILE --output FILE',
    'pi-factory run-list --repo PATH',
    'pi-factory status --repo PATH --run RUN_ID',
    'pi-factory doctor [--config FILE] [--repo PATH]',
  ]) assert.ok(help.stdout.includes(command), `CLI help missing ${command}`);
  assert.match(start, /pi-factory plan --repo PATH --config CONFIG_FILE --objective OBJECTIVE_FILE --output PLAN_FILE/);
  assert.match(start, /Stop for review/);
  assert.match(start, /Planning is not approval to execute/);
  assert.match(status, /pi-factory run-list --repo PATH/);
  assert.match(status, /pi-factory status --repo PATH --run RUN_ID/);
  assert.match(status, /pi-factory doctor --repo PATH --config CONFIG_FILE/);
  assert.match(status, /do not recover, resume, amend, integrate or publish/i);
  assert.doesNotMatch(start + status, /npm run factory/);
});
