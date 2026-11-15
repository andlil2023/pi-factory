import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPi } from '../src/pi-runner.ts';
import { ContractValidator } from '../src/contract-validator.ts';

// Explicit opt-in: this test invokes a real model and may incur usage charges.
const enabled = process.env.PI_FACTORY_INTEGRATION === '1';
const root = resolve(import.meta.dirname, '..');

test('real PI Planner produces a valid calculator plan', { skip: !enabled && 'Set PI_FACTORY_INTEGRATION=1 to run a paid model invocation', timeout: 420_000 }, async () => {
    const repository = await mkdtemp(join(tmpdir(), 'pi-factory-planner-'));
    try {
        const git = spawnSync('git', ['init', '--quiet'], { cwd: repository, encoding: 'utf8' });
        assert.equal(git.status, 0, `git init failed: ${git.stderr}`);
        await writeFile(join(repository, 'README.md'), '# Calculator Sandbox\n\nEmpty test project.\n');
        const instructionsFile = join(root, 'agents', 'planner.md');
        const provider = process.env.PI_PROVIDER || 'openai-codex';
        const model = process.env.PI_MODEL || 'gpt-6.1-terra';
        // On Windows, PowerShell resolves pi.ps1, but Node spawn('pi') cannot.
        // Invoke the installed PI JavaScript entry point directly instead.
        const piEntryPoint = join(
            process.env.APPDATA ?? '',
            'npm', 'node_modules', '@earendil-works', 'pi-coding-agent',
            'dist', 'bundle', 'cli.js'
        );
        const executable = process.env.PI_EXECUTABLE || (process.platform === 'win32' ? process.execPath : 'pi');
        const executableArgs = process.env.PI_EXECUTABLE_ARGS
            ? JSON.parse(process.env.PI_EXECUTABLE_ARGS) as string[]
            : process.platform === 'win32' ? [piEntryPoint] : [];
        const prompt = [
            'Plan a small command-line calculator supporting addition and subtraction.',
            'The repository is an empty sandbox. Do not modify files.',
            'Use JavaScript with Node.js built-in test runner unless existing project rules require otherwise.',
            'Return ONLY a JSON object matching the plan schema described below, no Markdown fences:',
            JSON.stringify(JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'contracts', 'plan.schema.json'), 'utf8'))),
            'Keep the plan small (normally 1-3 coherent tasks); list real acceptance criteria and verification steps.'
        ].join('\n\n');
        const result = await runPi({
            role: 'planner', repository, instructionsFile, provider, model,
            executable, executableArgs, tools: ['read', 'grep', 'find', 'ls'],
            prompt, timeoutMs: 360_000
        });
        const finalMessage = extractFinalAssistantText(result.events);
        assert.ok(finalMessage, 'PI produced no final assistant text; inspect the JSON event stream');
        const jsonText = stripCodeFence(finalMessage);
        const validator = new ContractValidator(join(root, 'contracts'));
        const validation = await validator.validate<{ tasks: { id: string; title: string }[] }>('plan', jsonText);
        assert.ok(validation.valid, `Invalid Planner output:\n${JSON.stringify(validation.issues, null, 2)}\n\nRaw response:\n${finalMessage}`);
        console.log(`\nPlanner: ${provider}/${model}; ${result.durationMs}ms; ${validation.value.tasks.length} tasks`);
        for (const task of validation.value.tasks) console.log(`  ${task.id}: ${task.title}`);
        console.log(`Usage events: ${JSON.stringify(extractUsage(result.events))}`);
    } finally {
        await rm(repository, { recursive: true, force: true });
    }
});

function extractFinalAssistantText(events: unknown[]): string {
    let last = '';
    for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        const e = event as Record<string, unknown>;
        if (e.type !== 'message_end') continue;
        const message = e.message;
        if (!message || typeof message !== 'object') continue;
        const m = message as Record<string, unknown>;
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
        const text = m.content.filter((x): x is { type: string; text: string } => !!x && typeof x === 'object' && (x as { type?: unknown }).type === 'text' && typeof (x as { text?: unknown }).text === 'string').map(x => x.text).join('');
        if (text.trim()) last = text;
    }
    return last;
}

function stripCodeFence(value: string): string {
    const trimmed = value.trim();
    const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    return match ? match[1].trim() : trimmed;
}

function extractUsage(events: unknown[]): unknown[] {
    return events.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .filter(e => e.type === 'message_end' && !!e.message && typeof e.message === 'object' && 'usage' in e.message)
        .map(e => (e.message as Record<string, unknown>).usage);
}
