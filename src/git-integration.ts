import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertCheckoutCheckpoint, validateRunGitState } from './run-recovery.ts';
import { assertUiEvidenceCurrent } from './ui-evidence.ts';
import { appendReviewResult, reconcileReviewResults } from './review-results.ts';
import type { FactoryRunState, IntegrationAttempt, StateStore } from './state-store.ts';
import type { OrchestratorAdapters, PlannedTask, TaskContext } from './orchestrator.ts';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
export interface IntegrationOptions {
  configurationFingerprint: string;
  enabledReviewers: string[];
  task: PlannedTask;
  adapters(worktree: string, baseline: string, attempt: number): OrchestratorAdapters;
}

function eligible(state: FactoryRunState, options: IntegrationOptions): void {
  if (state.status !== 'completed' || !Object.keys(state.tasks).length || Object.values(state.tasks).some(task => task.status !== 'completed') || !state.finalVerification?.passed) throw new Error('Integration requires a completed, finally verified run');
  if (!state.execution || !Number.isSafeInteger(state.execution.maxAttempts) || state.execution.maxAttempts < 1 || state.execution.configurationFingerprint !== options.configurationFingerprint) throw new Error('Integration requires the original execution configuration');
  if (!options.enabledReviewers.includes('code') || new Set(options.enabledReviewers).size !== options.enabledReviewers.length) throw new Error('Invalid enabled integration reviewers');
}
async function assertPinnedRefs(state: FactoryRunState, record: IntegrationAttempt): Promise<void> {
  const observed = await validateRunGitState(state, state.repository);
  if (observed.targetHead !== record.targetHead || state.git!.expectedHead !== record.sourceHead || state.git!.targetBranch !== record.targetBranch) throw new Error('Integration source or target moved; prepare a new candidate');
}
async function assertCandidate(state: FactoryRunState, record: IntegrationAttempt): Promise<void> {
  if (!Number.isSafeInteger(record.number) || record.number < 1 || record.branch !== `factory-integration/${state.runId}-${record.number}`) throw new Error('Invalid integration branch metadata');
  if (!record.commit || !/^[a-f0-9]{40,64}$/.test(record.commit)) throw new Error('Missing integration candidate commit');
  const repo = await realpath(state.repository);
  const worktree = await realpath(record.worktree);
  if (repo === worktree || worktree !== await realpath(await git(worktree, ['rev-parse', '--show-toplevel']))) throw new Error('Invalid integration worktree');
  const common = async (cwd: string) => realpath(resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'])));
  if (await common(repo) !== await common(worktree)) throw new Error('Integration worktree belongs to another repository');
  const registered = (await git(repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  let found = false;
  for (const entry of registered) {
    const fields = entry.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9);
    if (path && fields.includes(`branch refs/heads/${record.branch}`) && await realpath(path) === worktree) found = true;
  }
  if (!found) throw new Error('Integration worktree/branch is not registered');
  await assertCheckoutCheckpoint(worktree, record.branch, record.commit);
  const parents = (await git(worktree, ['rev-list', '--parents', '-n', '1', record.commit])).split(' ');
  if (parents.length !== 3 || parents[1] !== record.targetHead || parents[2] !== record.sourceHead) throw new Error('Integration candidate does not merge the pinned target and source');
}
function contextFor(state: FactoryRunState, record: IntegrationAttempt, options: IntegrationOptions): TaskContext {
  return {
    task: options.task, attempt: record.number,
    previousFeedback: (state.integrations ?? []).filter(previous => previous.number < record.number).flatMap(previous => [previous.verification, ...(previous.reviews ?? []).map(review => review.report), previous.uiEvidence, previous.error].filter(value => value !== undefined)),
    requiredReviewers: record.reviewSelection?.requiredReviewers,
    uiEvidence: record.uiEvidence
  };
}

/** Caller holds run + repository integration locks and obtained explicit preparation approval. */
export async function prepareIntegration(store: StateStore, state: FactoryRunState, options: IntegrationOptions, newAttempt = false): Promise<IntegrationAttempt> {
  eligible(state, options);
  const observed = await validateRunGitState(state, state.repository);
  const previous = [...(state.integrations ?? [])];
  if (previous.some(record => record.status === 'published' || record.status === 'publishing')) throw new Error('Integration already published or publication needs manual reconciliation');
  if (previous.length && !newAttempt) throw new Error('An integration attempt already exists; inspect it, then publish the ready candidate or explicitly pass --new-attempt');
  if (previous.length >= state.execution!.maxAttempts) throw new Error('Integration attempt budget exhausted');
  let included = false;
  try { await git(state.repository, ['merge-base', '--is-ancestor', state.git!.expectedHead, observed.targetHead]); included = true; }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  if (included) throw new Error('Target already contains the run; no integration is needed');
  const number = previous.length + 1;
  const record: IntegrationAttempt = {
    number, status: 'preparing', approvedAt: new Date().toISOString(),
    worktree: join(dirname(await realpath(state.repository)), '.factory-integrations', state.runId, `attempt-${number}`),
    branch: `factory-integration/${state.runId}-${number}`, targetBranch: state.git!.targetBranch,
    targetHead: observed.targetHead, sourceHead: state.git!.expectedHead
  };
  state.integrations ??= [];
  state.integrations.push(record);
  await store.save(state);
  try {
    await mkdir(dirname(record.worktree), { recursive: true });
    await git(state.repository, ['worktree', 'add', '-b', record.branch, record.worktree, record.targetHead]);
    record.worktree = await realpath(record.worktree);
    await store.save(state);
    try {
      await git(record.worktree, ['-c', 'user.name=PI Factory', '-c', 'user.email=pi-factory@localhost', 'merge', '--no-ff', '--no-edit', record.sourceHead]);
    } catch {
      record.conflicts = (await git(record.worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
      record.status = record.conflicts.length ? 'conflicted' : 'blocked';
      record.error = record.conflicts.length ? 'Merge conflicts preserved for human inspection' : 'Git merge failed; integration worktree preserved for inspection';
      await store.save(state);
      return record;
    }
    record.commit = await git(record.worktree, ['rev-parse', 'HEAD']);
    await assertCandidate(state, record);
    const adapters = options.adapters(record.worktree, record.targetHead, number);
    const context = contextFor(state, record, options);
    record.verification = await adapters.verify(context);
    await store.save(state);
    if (!record.verification.passed) throw new Error('Integration verification failed');
    await assertCandidate(state, record);
    const selection = adapters.selectReviewers ? await adapters.selectReviewers(context) : { requiredReviewers: [...options.enabledReviewers], changedFiles: [], reasons: ['Static integration review requirements'] };
    const valid = (ids: string[]) => ids.includes('code') && new Set(ids).size === ids.length && ids.every(id => options.enabledReviewers.includes(id));
    if (!valid(selection.requiredReviewers)) throw new Error('Invalid integration reviewer selection');
    const required = new Set([...selection.requiredReviewers, ...previous.flatMap(attempt => attempt.reviewSelection?.requiredReviewers ?? [])]);
    if (!valid([...required])) throw new Error('Previously required integration reviewer is no longer enabled');
    record.reviewSelection = { ...selection, requiredReviewers: options.enabledReviewers.filter(id => required.has(id)) };
    context.requiredReviewers = [...record.reviewSelection.requiredReviewers];
    await store.save(state);
    if (context.requiredReviewers.includes('ui') && adapters.collectUiEvidence) {
      record.uiEvidence = await adapters.collectUiEvidence(context);
      context.uiEvidence = record.uiEvidence;
      await store.save(state);
      if (!record.uiEvidence.passed) throw new Error('Integration UI evidence failed');
    }
    const reviews = await adapters.review(context, { outcome: 'implemented', report: { summary: 'Deterministic integration candidate, not proof of correctness', source: record.sourceHead, target: record.targetHead, candidate: record.commit } }, record.verification, async review => {
      record.reviews ??= [];
      appendReviewResult(record.reviews, review, context.requiredReviewers!);
      await store.save(state);
    });
    record.reviews = reconcileReviewResults(record.reviews ?? [], reviews);
    await store.save(state);
    const ids = new Set(record.reviews.map(review => review.reviewer));
    if (ids.size !== record.reviews.length || ids.size !== context.requiredReviewers.length || context.requiredReviewers.some(id => !ids.has(id)) || record.reviews.some(review => review.verdict !== 'approved')) throw new Error('Integration requires exact, unanimous reviewer approval');
    await assertCandidate(state, record);
    try { await assertPinnedRefs(state, record); }
    catch (error) { record.status = 'stale'; throw error; }
    record.status = 'ready';
  } catch (error) {
    if (record.status !== 'stale') record.status = 'blocked';
    record.error = error instanceof Error ? error.message.split('\n')[0] : 'Integration failed';
  }
  await store.save(state);
  return record;
}

/** Explicit second approval names the exact reviewed commit; never rewrites target history. */
export async function publishIntegration(store: StateStore, state: FactoryRunState, options: IntegrationOptions, candidate: string): Promise<IntegrationAttempt> {
  eligible(state, options);
  const record = state.integrations?.at(-1);
  if (!record || record.status !== 'ready' || record.commit !== candidate) throw new Error('Publication requires the latest ready candidate and its exact --candidate SHA');
  try {
    await assertPinnedRefs(state, record);
    await assertCandidate(state, record);
    const required = record.reviewSelection?.requiredReviewers;
    const reviews = record.reviews ?? [];
    const ids = new Set(reviews.map(review => review.reviewer));
    if (!record.verification?.passed || !required?.includes('code') || new Set(required).size !== required.length || required.some(id => !options.enabledReviewers.includes(id)) || required.length !== ids.size || ids.size !== reviews.length || required.some(id => !ids.has(id)) || reviews.some(review => review.verdict !== 'approved')) throw new Error('Ready candidate lacks complete verification/review evidence');
    await assertCheckoutCheckpoint(state.repository, record.targetBranch, record.targetHead);
    const adapters = options.adapters(record.worktree, record.targetHead, record.number);
    record.publicationVerification = await adapters.verify(contextFor(state, record, options));
    await store.save(state);
    if (!record.publicationVerification.passed) throw new Error('Pre-publication verification failed');
    if (required.includes('ui') && adapters.collectUiEvidence) {
      if (!record.uiEvidence || record.uiEvidence.manifest?.taskId !== options.task.id || record.uiEvidence.manifest?.attempt !== record.number) throw new Error('Required integration UI evidence is missing');
      await assertUiEvidenceCurrent(record.uiEvidence, record.worktree);
    }
    await assertCandidate(state, record);
    await assertPinnedRefs(state, record);
    await assertCheckoutCheckpoint(state.repository, record.targetBranch, record.targetHead);
  } catch (error) {
    record.status = 'blocked';
    record.error = error instanceof Error ? error.message.split('\n')[0] : 'Publication preflight failed';
    await store.save(state);
    throw error;
  }
  record.status = 'publishing';
  record.publishApprovedAt = new Date().toISOString();
  await store.save(state);
  // From here on, failure is ambiguous and requires inspection, not automatic retry/rollback.
  try {
    await git(state.repository, ['merge', '--ff-only', '--no-edit', record.commit!]);
    await assertCheckoutCheckpoint(state.repository, record.targetBranch, record.commit!);
    record.status = 'published';
    record.publishedAt = new Date().toISOString();
    await store.save(state);
  } catch (error) {
    record.status = 'publishing';
    record.error = 'Publication needs manual reconciliation; inspect target HEAD and preserved evidence';
    await store.save(state);
    throw error;
  }
  return record;
}
