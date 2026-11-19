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
    'pi-factory spec check --spec FILE',
    'pi-factory spec review --repo PATH --config FILE --spec FILE',
    'pi-factory spec impact --repo PATH --config FILE --spec FILE',
    'pi-factory spec publish --repo PATH --config FILE --spec FILE --approve',
    'pi-factory start --repo PATH --config FILE --spec REF [--sha256 HASH] [--new-run] --approve',
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

test('specification and start skill command examples use CLI help syntax', () => {
  const help = spawnSync(process.execPath, ['bin/pi-factory.js', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const skills = ['factory-start', 'factory-spec'].map(name =>
    readFileSync(new URL(`../.pi/skills/${name}/SKILL.md`, import.meta.url), 'utf8'));
  const usage = help.stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('pi-factory '));
  const examples = skills.flatMap(skill => [...skill.matchAll(/pi-factory [a-z-]+(?: [a-z-]+)?(?: --[\w-]+(?: [A-Z_]+)?)+/g)].map(match => match[0]));
  assert.equal(examples.length, 6, 'expected plan, start and four specification command examples');
  for (const example of examples) {
    const tokens = example.split(' ');
    const command = tokens[1] === 'spec' ? tokens.slice(0, 3).join(' ') : tokens.slice(0, 2).join(' ');
    const syntax = usage.find(line => line.startsWith(`${command} `));
    assert.ok(syntax, `CLI help missing ${command}`);
    const supported = [...syntax.matchAll(/(--[\w-]+)(?: ([A-Z_]+))?/g)];
    const flags = [...example.matchAll(/(--[\w-]+)(?: ([A-Z_]+))?/g)];
    for (const flag of flags) {
      const entry = supported.find(item => item[1] === flag[1]);
      assert.ok(entry, `${example}: unsupported flag ${flag[1]}`);
      assert.equal(Boolean(flag[2]), Boolean(entry[2]), `${example}: incorrect value for ${flag[1]}`);
    }
    for (const entry of supported) {
      if (syntax[entry.index! - 1] !== '[') assert.ok(flags.some(flag => flag[1] === entry[1]), `${example}: missing ${entry[1]}`);
    }
  }
  assert.match(skills[0], /factory-spec/);
  assert.match(skills[0], /explicitly requests execution/);
  assert.match(skills[0], /approval of the specification/);
});
