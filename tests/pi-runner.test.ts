import test, { type TestContext } from "node:test";
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPi, PiRunError, type PiRunRequest } from '../src/pi-runner.ts';

/** Cross-platform process tests: launch fake PI via the Node executable. */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pi factory runner '));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const instructionsFile = join(dir, 'planner.md');
  await writeFile(instructionsFile, '# Planner\nReturn a plan.\n');
  const executable = process.execPath;
  const fakeScript = new URL('./fixtures/fake-pi.mjs', import.meta.url);
  const request: PiRunRequest = {
    role: 'planner', executable, executableArgs: [fileURLToPath(fakeScript)], repository: dir, instructionsFile,
    provider: 'openai', model: 'test-model', prompt: 'hello', timeoutMs: 5000,
    tools: ['read', 'grep'],
  };
  return { dir, request };
}

test('rejects empty prompt before launching PI', async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(runPi({ ...request, prompt: '   ' }), /Prompt cannot be empty/);
});

test('rejects missing model or provider', async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(runPi({ ...request, model: '' }), /Provider and model are required/);
  await assert.rejects(runPi({ ...request, provider: '' }), /Provider and model are required/);
});

test('rejects invalid timeout', async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(runPi({ ...request, timeoutMs: -1 }), /timeoutMs must be a positive integer/);
});

test('rejects empty instruction file', async (t) => {
  const { dir, request } = await fixture(t);
  const blank = join(dir, 'blank.md');
  await writeFile(blank, '   ');
  await assert.rejects(runPi({ ...request, instructionsFile: blank }), /Agent instructions are empty/);
});


test('launches a fresh process and captures JSON events and arguments', async (t) => {
  const { dir, request } = await fixture(t);
  const result = await runPi(request);
  assert.equal(result.exitCode, 0);
  assert.equal(result.role, 'planner');
  assert.ok(result.durationMs >= 0);
  assert.equal(result.events.length, 1);
  const event = result.events[0] as { args: string[]; cwd: string; prompt: string; instructions: string };
  assert.equal(event.cwd, dir);
  assert.deepEqual(event.args.slice(0, 4), ['--print', '--mode', 'json', '--no-session']);
  assert.ok(event.args.includes('--append-system-prompt'));
  assert.equal(event.args[event.args.indexOf('--append-system-prompt') + 1], resolve(request.instructionsFile));
  assert.equal(event.instructions, '# Planner\nReturn a plan.\n');
  assert.ok(event.args.includes('read,grep'));
  assert.ok(!event.args.includes('hello'));
  assert.equal(event.prompt, 'hello');
});

test('transports large Unicode review evidence and instructions without argv truncation', async t => {
  const { request } = await fixture(t);
  const prompt = '--literal @not-a-file "quoted"\n' + 'Å中🙂\\review\n'.repeat(70_000);
  const instructions = '# Large reviewer instructions\n' + 'Instruction text.\n'.repeat(12_000);
  await writeFile(request.instructionsFile, instructions);
  const result = await runPi({ ...request, prompt });
  const event = result.events[0] as { args: string[]; prompt: string; instructions: string };
  assert.equal(event.prompt, prompt);
  assert.equal(event.instructions, instructions);
  assert.ok(event.args.join(' ').length < 4096);
  assert.ok(!event.args.includes(prompt));
  assert.ok(!event.args.includes(instructions));
});

test('missing executable rejects without uncaught pipe errors', async t => {
  const { dir, request } = await fixture(t);
  await assert.rejects(runPi({ ...request, executable: join(dir, 'missing-pi-executable'), prompt: 'large'.repeat(200_000) }), /Unable to launch PI/);
});

test('early exit during a large stdin write preserves failure without uncaught EPIPE', async t => {
  const { request } = await fixture(t);
  await assert.rejects(runPi({ ...request,
    executableArgs: [fileURLToPath(new URL('./fixtures/fake-pi-input-failure.mjs', import.meta.url)), 'exit'],
    prompt: 'large'.repeat(200_000)
  }), PiRunError);
});

test('times out with a large prompt when the child never consumes stdin', async t => {
  const { request } = await fixture(t);
  await assert.rejects(runPi({ ...request,
    executableArgs: [fileURLToPath(new URL('./fixtures/fake-pi-input-failure.mjs', import.meta.url)), 'stall'],
    prompt: 'large'.repeat(200_000), timeoutMs: 250
  }), /timed out/);
});

test('cancels with a large prompt when the child never consumes stdin', async t => {
  const { request } = await fixture(t);
  const controller = new AbortController();
  const pending = runPi({ ...request,
    executableArgs: [fileURLToPath(new URL('./fixtures/fake-pi-input-failure.mjs', import.meta.url)), 'stall'],
    prompt: 'large'.repeat(200_000), signal: controller.signal
  });
  setTimeout(() => controller.abort(), 250);
  await assert.rejects(pending, /cancelled/);
});

test('rejects nonzero process exit', async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(runPi({ ...request, prompt: 'fail' }), (e: unknown) => {
    assert.ok(e instanceof PiRunError);
    assert.match(e.message, /exited with code 7/);
    assert.match(e.details ?? '', /fake failure/);
    return true;
  });
});

test('rejects malformed JSON output', async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(runPi({ ...request, prompt: 'invalid' }), /invalid JSON event output/);
});

test('rejects empty event stream', async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(runPi({ ...request, prompt: 'empty' }), /no JSON events/);
});

test('times out a stalled PI process', async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(runPi({ ...request, prompt: 'sleep', timeoutMs: 150 }), /timed out/);
});

test('cancels an in-flight PI process', async (t) => {
  const { request } = await fixture(t);
  const controller = new AbortController();
  const pending = runPi({ ...request, prompt: 'sleep', signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, /cancelled/);
});
