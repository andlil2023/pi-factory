import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('entry point initializes and runs workflows using its own assets outside the checkout', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'factory-cli-'));
  try {
    // A separate package tree ensures neither templates nor agent assets can be found via cwd.
    const pkg = join(temp, 'package');
    await mkdir(pkg);
    for (const item of ['bin', 'src', 'agents', 'contracts', 'examples', 'templates', 'factory.config.example.json', 'package.json']) {
      await cp(join(root, item), join(pkg, item), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(pkg, 'node_modules'), 'junction');
    const cwd = join(temp, 'caller');
    const target = join(temp, 'target');
    await mkdir(cwd);
    await mkdir(target);
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(pkg, 'bin', 'pi-factory.js'), ...args], { cwd, encoding: 'utf8' });
    assert.notEqual(cli('init').status, 0);
    const initialized = cli('init', '--repo', target);
    assert.equal(initialized.status, 0, initialized.stderr);
    const configPath = join(target, '.factory', 'config.json');
    const objectivePath = join(target, '.factory', 'objective.md');
    const templatePath = join(target, '.factory', 'specification-template.md');
    assert.equal(await readFile(templatePath, 'utf8'), await readFile(join(pkg, 'templates', 'specification.md'), 'utf8'));
    assert.equal(await readFile(configPath, 'utf8'), await readFile(join(pkg, 'factory.config.example.json'), 'utf8'));
    assert.equal(await readFile(objectivePath, 'utf8'), await readFile(join(pkg, 'examples', 'objective.md'), 'utf8'));
    await writeFile(configPath, 'custom config');
    await writeFile(objectivePath, 'custom objective');
    await writeFile(templatePath, 'custom template');
    assert.equal(cli('init', '--repo', target).status, 0);
    assert.equal(await readFile(templatePath, 'utf8'), 'custom template');
    assert.equal(await readFile(configPath, 'utf8'), 'custom config');
    assert.equal(await readFile(objectivePath, 'utf8'), 'custom objective');
    assert.equal(cli('init', '--repo', target, '--force').status, 0);
    assert.equal(await readFile(templatePath, 'utf8'), await readFile(join(pkg, 'templates', 'specification.md'), 'utf8'));
    assert.equal(await readFile(configPath, 'utf8'), await readFile(join(pkg, 'factory.config.example.json'), 'utf8'));
    assert.equal(await readFile(objectivePath, 'utf8'), await readFile(join(pkg, 'examples', 'objective.md'), 'utf8'));

    const fake = join(temp, 'fake.mjs');
    const plan = { objective: 'Test', assumptions: [], decisions: [], tasks: [{ id: 'T001', title: 'Test', objective: 'Test', scope: 'Test', acceptanceCriteria: ['Works'], dependencies: [], verification: ['Test'] }], verification: ['Test'] };
    await writeFile(fake, `import { readFileSync } from 'node:fs';\nconst instruction = process.argv[process.argv.indexOf('--append-system-prompt') + 1];\nif (instruction !== ${JSON.stringify(join(pkg, 'agents', 'planner.md'))} || !readFileSync(instruction, 'utf8').trim()) process.exit(2);\nlet input=''; for await (const chunk of process.stdin) input += chunk;\nif (!input.includes('PI Factory Plan')) process.exit(3);\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(${JSON.stringify(plan)})}]}}));\n`);
    const config = join(temp, 'selected-config.json');
    await writeFile(config, JSON.stringify({ agents: { planner: { provider: 'test', model: 'test' }, implementer: { provider: 'test', model: 'test' }, reviewer: { provider: 'test', model: 'test' } }, planning: { maxReviewRounds: 0 }, verification: [{ executable: process.execPath, args: ['--version'] }], pi: { executable: process.execPath, executableArgs: [fake] } }));
    const output = join(temp, 'plan.json');
    const planned = cli('plan', '--repo', target, '--config', config, '--objective', objectivePath, '--output', output);
    assert.equal(planned.status, 0, planned.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), plan);
    for (const command of ['run', 'resume', 'amend', 'integrate']) {
      const rejected = cli(command, '--repo', target, '--config', config, '--plan', output, '--run', 'example');
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /requires --approve/i);
    }
    const invalidTarget = cli('run', '--repo', target, '--config', config, '--plan', output, '--approve');
    assert.notEqual(invalidTarget.status, 0);
    assert.match(invalidTarget.stderr, /git rev-parse failed/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
