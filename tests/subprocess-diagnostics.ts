import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';

const outputLimit = 4096;

export function subprocessDiagnostics(result: SpawnSyncReturns<string>): string {
  const bounded = (output: string | null) => {
    const text = output ?? '';
    return text.length > outputLimit ? `${text.slice(0, outputLimit)}… [truncated]` : text;
  };
  const error = result.error as NodeJS.ErrnoException | undefined;
  return `status: ${result.status}; error code: ${error?.code ?? 'unavailable'}; signal: ${result.signal ?? 'none'}\nstdout: ${bounded(result.stdout)}\nstderr: ${bounded(result.stderr)}`;
}

export function assertSubprocessStarted(result: SpawnSyncReturns<string>): void {
  assert.equal(result.error, undefined, subprocessDiagnostics(result));
  assert.equal(result.signal, null, subprocessDiagnostics(result));
}
