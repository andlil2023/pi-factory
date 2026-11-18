import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function checked(result: SpawnSyncReturns<string>, description: string): string {
  assert.equal(result.status, 0, `${description}: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

// Invoke npm's JavaScript entry point on Windows rather than relying on shell execution of npm.cmd.
function npm(args: string[], cwd: string): SpawnSyncReturns<string> {
  const npmCli = process.env.npm_execpath || (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined);
  return npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', timeout: 180_000 })
    : spawnSync('npm', args, { cwd, encoding: 'utf8', timeout: 180_000 });
}

test('packed artifact installs and runs in a separate Git repository', { timeout: 240_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'factory-artifact-'));
  try {
    const install = join(temp, 'install');
    const target = join(temp, 'sample');
    const caller = join(temp, 'caller');
    await Promise.all([mkdir(install), mkdir(target), mkdir(caller)]);
    // CI supplies the exact tarball it will retain for release. Locally, pack one
    // into the temporary directory so this test remains independently runnable.
    let tarball = process.env.PI_FACTORY_TEST_TARBALL;
    if (!tarball) {
      const packed = JSON.parse(checked(npm(['pack', '--json', '--pack-destination', temp], root), 'npm pack')) as Array<{ filename: string }>;
      assert.equal(packed.length, 1);
      tarball = join(temp, packed[0].filename);
    }
    checked(npm(['install', '--no-audit', '--no-fund', '--prefix', install, tarball], caller), 'npm install');
    checked(spawnSync('git', ['init', target], { cwd: caller, encoding: 'utf8' }), 'git init');

    const bin = join(install, 'node_modules', '.bin', process.platform === 'win32' ? 'pi-factory.cmd' : 'pi-factory');
    const cli = (...args: string[]): SpawnSyncReturns<string> => {
      if (process.platform === 'win32') {
        // cmd needs an outer pair of quotes when the command path itself is quoted.
        const command = [bin, ...args].map(arg => `"${arg}"`).join(' ');
        return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`],
          { cwd: caller, encoding: 'utf8', timeout: 30_000, windowsVerbatimArguments: true });
      }
      return spawnSync(bin, args, { cwd: caller, encoding: 'utf8', timeout: 30_000 });
    };

    checked(cli('init', '--repo', target), 'installed init');
    const objective = join(target, '.factory', 'objective.md');
    const config = join(target, '.factory', 'config.json');
    assert.ok((await readFile(objective, 'utf8')).trim());
    assert.ok(JSON.parse(await readFile(config, 'utf8')).agents);

    const plan = { objective: 'Smoke test', assumptions: [], decisions: [], tasks: [{ id: 'T001', title: 'Test', objective: 'Test', scope: 'Test', acceptanceCriteria: ['Works'], dependencies: [], verification: ['Test'] }], verification: ['Test'] };
    const fake = join(temp, 'fake-pi.mjs');
    const instructions = join(install, 'node_modules', 'pi-factory', 'agents', 'planner.md');
    await writeFile(fake, `import { readFileSync } from 'node:fs';\n` +
      `if (process.cwd() !== ${JSON.stringify(target)}) process.exit(2);\n` +
      `const instruction = process.argv[process.argv.indexOf('--append-system-prompt') + 1];\n` +
      `if (instruction !== ${JSON.stringify(instructions)} || !readFileSync(instruction, 'utf8').trim()) process.exit(3);\n` +
      `let input = ''; for await (const chunk of process.stdin) input += chunk;\n` +
      `if (!input.includes('PI Factory Plan')) process.exit(4);\n` +
      `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(${JSON.stringify(plan)})}]}}));\n`);
    await writeFile(config, JSON.stringify({ agents: { planner: { provider: 'fixture', model: 'fixture' }, implementer: { provider: 'fixture', model: 'fixture' }, reviewer: { provider: 'fixture', model: 'fixture' } }, planning: { maxReviewRounds: 0 }, verification: [{ executable: process.execPath, args: ['--version'] }], pi: { executable: process.execPath, executableArgs: [fake] } }));
    const output = join(temp, 'plan.json');
    checked(cli('plan', '--repo', target, '--config', config, '--objective', objective, '--output', output), 'installed plan');
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), plan);

    const rejected = cli('run', '--repo', target, '--config', config, '--plan', output);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /requires --approve/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
