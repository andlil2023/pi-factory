import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertCheckoutCheckpoint, validateRunGitState, MAX_GUIDANCE_LENGTH } from './run-recovery.ts';
import { assertUiEvidenceCurrent } from './ui-evidence.ts';
import { appendReviewResult, reconcileReviewResults } from './review-results.ts';
import * as github from './github-pr.ts';
import type { FactoryRunState, IntegrationAttempt, StateStore } from './state-store.ts';
import type { OrchestratorAdapters, PlannedTask, TaskContext } from './orchestrator.ts';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
export async function hasGitRemote(repository: string): Promise<boolean> { return Boolean(await git(repository, ['remote'])); }

export interface IntegrationOptions {
  configurationFingerprint: string;
  enabledReviewers: string[];
  task: PlannedTask;
  /** Approved preparation input only; cannot be changed during publication. */
  guidance?: string;
  adapters(worktree: string, baseline: string, attempt: number): OrchestratorAdapters;
  /** Trusted, configured preparation of a fresh integration worktree (for example dependency install). Throws on failure. */
  setup?(worktree: string): Promise<void>;
  /** Publication accepts the preparation's passing verification of the identical Git tree instead of rerunning the commands. */
  reuseVerification?: boolean;
  /** Dependency injection for independently tested GitHub transport. */
  github?: Pick<typeof github, 'githubDestination' | 'remoteHead' | 'pushCandidate' | 'createPullRequest' | 'verifyPullRequest'>;
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
async function setPhase(store: StateStore, state: FactoryRunState, record: IntegrationAttempt, phase: IntegrationAttempt['phase']): Promise<void> {
  record.phase = phase;
  record.phaseUpdatedAt = new Date().toISOString();
  await store.save(state);
}
function contextFor(state: FactoryRunState, record: IntegrationAttempt, options: IntegrationOptions, store: StateStore): TaskContext {
  return {
    task: options.task, plan: structuredClone(state.plan), attempt: record.number,
    onVerificationProgress: async progress => {
      record.verificationProgress = progress;
      await store.save(state);
    },
    integrationEvidence: {
      sourceRepository: state.repository,
      sourceWorktree: state.git!.worktree,
      taskGuidance: (state.resumptions ?? []).flatMap(entry => entry.retryTask && state.tasks[entry.retryTask]?.status === 'completed' && entry.guidance
        ? [{ taskId: entry.retryTask, approvedAt: entry.approvedAt, text: entry.guidance }] : []),
      integrationGuidance: (state.integrations ?? []).flatMap(entry => entry.number <= record.number && entry.guidance
        ? [{ attempt: entry.number, approvedAt: entry.approvedAt, text: entry.guidance }] : []),
      taskVerification: Object.values(state.tasks).filter(task => task.status === 'completed').flatMap(task => task.attempts.flatMap(attempt => attempt.verification === undefined ? [] : [{
        taskId: task.id, attempt: attempt.number, checkpoint: attempt.checkpointCommit, result: structuredClone(attempt.verification)
      }]))
    },
    previousFeedback: [
      ...(state.integrations ?? []).filter(previous => previous.number < record.number).flatMap(previous => [previous.verification, ...(previous.reviews ?? []).map(review => review.report), previous.uiEvidence, previous.error].filter(value => value !== undefined))
    ],
    requiredReviewers: record.reviewSelection?.requiredReviewers,
    uiEvidence: record.uiEvidence
  };
}

/** Caller holds run + repository integration locks and obtained explicit preparation approval. */
export async function prepareIntegration(store: StateStore, state: FactoryRunState, options: IntegrationOptions, newAttempt = false): Promise<IntegrationAttempt> {
  eligible(state, options);
  if (options.guidance !== undefined && (typeof options.guidance !== 'string' || !options.guidance.trim() || options.guidance.length > MAX_GUIDANCE_LENGTH)) throw new Error(`Integration guidance must contain 1-${MAX_GUIDANCE_LENGTH} characters`);
  const observed = await validateRunGitState(state, state.repository);
  const previous = [...(state.integrations ?? [])];
  if (previous.some(record => record.status === 'published' || record.status === 'publishing' || record.status === 'pr-publishing' || record.status === 'pr-opened')) throw new Error('Integration already published or publication needs manual reconciliation');
  if (previous.length && !newAttempt) throw new Error('An integration attempt already exists; inspect it, then publish the ready candidate or explicitly pass --new-attempt');
  if (previous.length >= state.execution!.maxAttempts) throw new Error('Integration attempt budget exhausted');
  let included = false;
  try { await git(state.repository, ['merge-base', '--is-ancestor', state.git!.expectedHead, observed.targetHead]); included = true; }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  if (included) throw new Error('Target already contains the run; no integration is needed');
  const number = previous.length + 1;
  const record: IntegrationAttempt = {
    number, status: 'preparing', phase: 'creating_worktree', phaseUpdatedAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
    ...(options.guidance === undefined ? {} : { guidance: options.guidance.trim() }),
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
    await setPhase(store, state, record, 'merging');
    try {
      await git(record.worktree, ['-c', 'user.name=PI Factory', '-c', 'user.email=pi-factory@localhost', 'merge', '--no-ff', '--no-edit', record.sourceHead]);
    } catch {
      record.conflicts = (await git(record.worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
      record.status = record.conflicts.length ? 'conflicted' : 'blocked';
      record.phase = 'stopped';
      record.phaseUpdatedAt = new Date().toISOString();
      record.error = record.conflicts.length ? 'Merge conflicts preserved for human inspection' : 'Git merge failed; integration worktree preserved for inspection';
      await store.save(state);
      return record;
    }
    record.commit = await git(record.worktree, ['rev-parse', 'HEAD']);
    await assertCandidate(state, record);
    const adapters = options.adapters(record.worktree, record.targetHead, number);
    const context = contextFor(state, record, options, store);
    await setPhase(store, state, record, 'setup');
    if (options.setup) await options.setup(record.worktree);
    await setPhase(store, state, record, 'verifying');
    // Never reused: this is the only verification in a fresh checkout with freshly set-up dependencies.
    // Earlier results came from the run worktree, whose ignored files a Git tree does not describe.
    record.verification = await adapters.verify(context);
    await store.save(state);
    if (!record.verification.passed) throw new Error('Integration verification failed');
    record.verifiedTree = await git(record.worktree, ['rev-parse', 'HEAD^{tree}']);
    await assertCandidate(state, record);
    await setPhase(store, state, record, 'selecting_reviewers');
    const selection = adapters.selectReviewers ? await adapters.selectReviewers(context) : { requiredReviewers: [...options.enabledReviewers], changedFiles: [], reasons: ['Static integration review requirements'] };
    const valid = (ids: string[]) => ids.includes('code') && new Set(ids).size === ids.length && ids.every(id => options.enabledReviewers.includes(id));
    if (!valid(selection.requiredReviewers)) throw new Error('Invalid integration reviewer selection');
    const required = new Set([...selection.requiredReviewers, ...previous.flatMap(attempt => attempt.reviewSelection?.requiredReviewers ?? [])]);
    if (!valid([...required])) throw new Error('Previously required integration reviewer is no longer enabled');
    record.reviewSelection = { ...selection, requiredReviewers: options.enabledReviewers.filter(id => required.has(id)) };
    context.requiredReviewers = [...record.reviewSelection.requiredReviewers];
    await store.save(state);
    if (context.requiredReviewers.includes('ui') && adapters.collectUiEvidence) {
      await setPhase(store, state, record, 'collecting_ui_evidence');
      record.uiEvidence = await adapters.collectUiEvidence(context);
      context.uiEvidence = record.uiEvidence;
      await store.save(state);
      if (!record.uiEvidence.passed) throw new Error('Integration UI evidence failed');
    }
    await setPhase(store, state, record, 'reviewing');
    const reviews = await adapters.review(context, { outcome: 'implemented', report: { summary: 'Deterministic integration candidate, not proof of correctness', source: record.sourceHead, target: record.targetHead, candidate: record.commit } }, record.verification, async review => {
      record.reviews ??= [];
      appendReviewResult(record.reviews, review, context.requiredReviewers!);
      await store.save(state);
    });
    record.reviews = reconcileReviewResults(record.reviews ?? [], reviews);
    await store.save(state);
    const ids = new Set(record.reviews.map(review => review.reviewer));
    if (ids.size !== record.reviews.length || ids.size !== context.requiredReviewers.length || context.requiredReviewers.some(id => !ids.has(id)) || record.reviews.some(review => review.verdict !== 'approved')) throw new Error('Integration requires exact, unanimous reviewer approval');
    await setPhase(store, state, record, 'checking_candidate');
    await assertCandidate(state, record);
    try { await assertPinnedRefs(state, record); }
    catch (error) { record.status = 'stale'; throw error; }
    record.status = 'ready';
    await setPhase(store, state, record, 'awaiting_publication');
  } catch (error) {
    record.phase = 'stopped';
    record.phaseUpdatedAt = new Date().toISOString();
    if (record.status !== 'stale') record.status = 'blocked';
    record.error = error instanceof Error ? error.message.split('\n')[0] : 'Integration failed';
  }
  await store.save(state);
  return record;
}

async function publicationPreflight(store: StateStore, state: FactoryRunState, options: IntegrationOptions, candidate: string): Promise<IntegrationAttempt> {
  eligible(state, options);
  if (options.guidance !== undefined) throw new Error('Publication cannot change integration guidance; prepare a new reviewed candidate');
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
    delete record.verificationProgress;
    await setPhase(store, state, record, 'publication_verifying');
    // Same worktree, same set-up dependencies, and assertCandidate proved it clean at the prepared commit:
    // the tree that preparation verified with every trusted command is the tree being published.
    const tree = await git(record.worktree, ['rev-parse', 'HEAD^{tree}']);
    record.publicationVerification = options.reuseVerification === true && record.verifiedTree === tree
      ? { passed: true, details: { mode: 'full', reused: { from: 'integration verification', tree } } }
      : await adapters.verify(contextFor(state, record, options, store));
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
    record.phase = 'stopped';
    record.phaseUpdatedAt = new Date().toISOString();
    record.error = error instanceof Error ? error.message.split('\n')[0] : 'Publication preflight failed';
    await store.save(state);
    throw error;
  }
  return record;
}

/** Explicit second approval names the exact reviewed commit; never rewrites target history. */
export async function publishIntegration(store: StateStore, state: FactoryRunState, options: IntegrationOptions, candidate: string): Promise<IntegrationAttempt> {
  if (await git(state.repository, ['remote'])) throw new Error('Local publication is disabled for repositories with configured remotes; use GitHub PR publication');
  const record = await publicationPreflight(store, state, options, candidate);
  if (await git(state.repository, ['remote'])) throw new Error('Local publication is disabled for repositories with configured remotes; use GitHub PR publication');
  record.status = 'publishing';
  record.publishApprovedAt = new Date().toISOString();
  await setPhase(store, state, record, 'publishing');
  // From here on, failure is ambiguous and requires inspection, not automatic retry/rollback.
  try {
    await git(state.repository, ['merge', '--ff-only', '--no-edit', record.commit!]);
    await assertCheckoutCheckpoint(state.repository, record.targetBranch, record.commit!);
    record.status = 'published';
    record.publishedAt = new Date().toISOString();
    await setPhase(store, state, record, 'published');
  } catch (error) {
    record.status = 'publishing';
    record.error = 'Publication needs manual reconciliation; inspect target HEAD and preserved evidence';
    await store.save(state);
    throw error;
  }
  return record;
}

/** Open a GitHub PR for the exact reviewed candidate; never merge or enable auto-merge. */
export async function publishPullRequest(store: StateStore, state: FactoryRunState, options: IntegrationOptions, candidate: string): Promise<IntegrationAttempt> {
  const record = await publicationPreflight(store, state, options, candidate);
  const api = options.github ?? github;
  const destination = await api.githubDestination(state.repository, record.targetBranch, record.targetHead, record.branch, candidate);
  if (await api.remoteHead(state.repository, destination.pushUrl, destination.base) !== destination.baseSha) throw new Error('GitHub base differs from the reviewed target; prepare a new candidate');
  if (await api.remoteHead(state.repository, destination.pushUrl, destination.head) !== undefined) throw new Error('GitHub candidate branch already exists; inspect it before proceeding');
  await assertPinnedRefs(state, record);
  await assertCandidate(state, record);
  record.pullRequest = { ...destination };
  record.status = 'pr-publishing';
  record.publishApprovedAt = new Date().toISOString();
  await setPhase(store, state, record, 'publishing');
  try {
    await api.pushCandidate(state.repository, destination);
    if (await api.remoteHead(state.repository, destination.pushUrl, destination.head) !== candidate) throw new Error('Remote candidate changed');
    if (await api.remoteHead(state.repository, destination.pushUrl, destination.base) !== destination.baseSha) throw new Error('Remote base changed');
    const current = await api.githubDestination(state.repository, record.targetBranch, record.targetHead, record.branch, candidate);
    if (JSON.stringify(current) !== JSON.stringify(destination)) throw new Error('Remote destination changed');
    await assertPinnedRefs(state, record);
    await assertCandidate(state, record);
    record.pullRequest.url = await api.createPullRequest(state.repository, destination);
    await store.save(state);
    await api.verifyPullRequest(state.repository, destination, record.pullRequest.url);
    if (await api.remoteHead(state.repository, destination.pushUrl, destination.head) !== candidate || await api.remoteHead(state.repository, destination.pushUrl, destination.base) !== destination.baseSha) throw new Error('Remote refs changed after PR creation');
    record.status = 'pr-opened';
    await setPhase(store, state, record, 'pr_opened');
    return record;
  } catch {
    record.status = 'pr-publishing';
    record.error = 'GitHub publication needs manual reconciliation; inspect the remote branch and pull requests before taking further action';
    await store.save(state);
    throw new Error(record.error);
  }
}
