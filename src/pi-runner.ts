import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type AgentRole = 'planner' | 'implementer' | 'reviewer' | (string & {});

export interface PiRunRequest {
  role: AgentRole;
  executable?: string;
  executableArgs?: readonly string[];
  repository: string;
  instructionsFile: string;
  prompt: string;
  provider: string;
  model: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  tools?: readonly string[];
}

export interface PiRunResult {
  role: AgentRole;
  exitCode: number;
  output: string;
  events: unknown[];
  stderr: string;
  durationMs: number;
}

export class PiRunError extends Error {
  readonly details?: string;
  constructor(message: string, details?: string) {
    super(message);
    this.details = details;
    this.name = 'PiRunError';
  }
}

/** One fresh PI process per invocation. Does not interpret agent contracts. */
export async function runPi(request: PiRunRequest): Promise<PiRunResult> {
  if (!request.prompt.trim()) throw new PiRunError('Prompt cannot be empty');
  if (!request.provider.trim() || !request.model.trim()) {
    throw new PiRunError('Provider and model are required');
  }

  const instructions = await readFile(resolve(request.instructionsFile), 'utf8');
  if (!instructions.trim()) throw new PiRunError('Agent instructions are empty');

  const args = [
    '--print', '--mode', 'json', '--no-session',
    '--provider', request.provider,
    '--model', request.model,
    '--append-system-prompt', instructions,
    ...(request.tools ? ['--tools', request.tools.join(',')] : []),
    request.prompt,
  ];

  const started = Date.now();
  const timeoutMs = request.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PiRunError('timeoutMs must be a positive integer');
  }

  return await new Promise<PiRunResult>((resolveResult, reject) => {
    // On Windows, PI is often installed as pi.cmd. Spawn via the shell
    // only when needed; do not concatenate user-supplied values into a command.
    // For reliable Windows operation, invoke the JS entrypoint or a configured
    // executable directly rather than shell-escaping a .cmd wrapper.
    const child = spawn(request.executable ?? 'pi', [...(request.executableArgs ?? []), ...args], {
      cwd: resolve(request.repository),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PiRunError(message, stderr.slice(-4000)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cancelled = true;
      child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finishError(`Unable to launch PI: ${error.message}`));
    child.on('close', (code) => {
      if (settled) return;
      if (timedOut) return finishError(`PI timed out after ${timeoutMs} ms`);
      if (cancelled) return finishError('PI execution cancelled');
      if (code !== 0) return finishError(`PI exited with code ${code ?? 'unknown'}`);

      const events: unknown[] = [];
      try {
        for (const line of stdout.split(/\r?\n/)) {
          if (line.trim()) events.push(JSON.parse(line));
        }
      } catch {
        return finishError('PI returned invalid JSON event output');
      }
      if (events.length === 0) return finishError('PI returned no JSON events');

      settled = true;
      cleanup();
      resolveResult({
        role: request.role,
        exitCode: 0,
        output: stdout,
        events,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}
