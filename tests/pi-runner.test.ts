import test, { type TestContext } from "node:test";
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPi, PiRunError, type PiRunRequest } from '../src/pi-runner.ts';

/** Cross-platform process tests: launch fake PI via the Node executable. */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-factory-runner-'));
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
  const event = result.events[0] as { args: string[]; cwd: string };
  assert.equal(event.cwd, dir);
  assert.deepEqual(event.args.slice(0, 4), ['--print', '--mode', 'json', '--no-session']);
  assert.ok(event.args.includes('--append-system-prompt'));
  assert.ok(event.args.includes('# Planner\nReturn a plan.\n'));
  assert.ok(event.args.includes('read,grep'));
  assert.equal(event.args.at(-1), 'hello');
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
