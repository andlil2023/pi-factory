import { readdir } from 'node:fs/promises';
import { DashboardReader } from './dashboard-reader.ts';

/** Inspect names and bounded, validated run records only; never open lock contents. */
export async function diagnoseRuns(repository:string, warnings:string[]):Promise<void> {
  const reader=new DashboardReader(repository);
  try {
    const names=await readdir(reader.directory);
    const locks=names.filter(name=>name.endsWith('.lock'));
    if (locks.length) warnings.push('Locks: lock records exist; inspect ownership and recovery guidance before proceeding. A lock does not establish process liveness; do not remove it without following recovery guidance.');
    if (names.some(name=>name.endsWith('.lock.recovery'))) warnings.push('Locks: recovery sentinels exist; inspect active or orphaned recovery before proceeding.');
    const runs=await reader.listRuns();
    const known=new Set(runs.map(entry=>entry.runId));
    const missing=locks.some(name=>!known.has(name.slice(0,-5)));
    if (missing || runs.some(entry=>!entry.available) || names.some(name=>name.endsWith('.json') && !/^[a-zA-Z0-9_-]+\.json$/.test(name))) warnings.push('Runs: some persisted records are missing or invalid; inspect them safely before resuming.');
    if (runs.some(entry=>entry.available && (entry.run.status==='running' || entry.run.tasks.some(task=>task.status==='running' || task.status==='needs_review' || task.attempts.some(attempt=>attempt.outcome==='interrupted' || !attempt.finishedAt))))) warnings.push('Runs: persisted running, interrupted or review-pending work may require attention; persisted status is not process liveness. Inspect run status and recovery guidance before resuming.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code!=='ENOENT') warnings.push('Runs and locks: unable to inspect persisted records; check directory permissions.');
  }
}
