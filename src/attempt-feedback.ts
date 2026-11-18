import type { AttemptRecord } from './state-store.ts';

export interface FeedbackFinding {
  reviewer: string;
  attempt: number;
  file?: string;
  line?: number;
  description: string;
  evidence?: string;
  requiredAction?: string;
}
export interface FailedCheck {
  command: string;
  /** Failing test names and compiler errors extracted from the output. */
  failures: string[];
  excerpt: string;
  /** Full output of the failed command, when the factory saved it. */
  logFile?: string;
}
export interface AttemptFeedback {
  /** Unresolved results of the most recent attempt that produced any. `findings` come from the last reviewed attempt, which may be earlier. */
  open: {
    attempt: number;
    reason: string;
    failedChecks: FailedCheck[];
    findings: FeedbackFinding[];
    uiEvidenceIssues: string[];
    implementerSummary?: string;
    blockers?: unknown[];
  };
  /** Blocking findings from before the last reviewed attempt. A later review did not repeat them; a repair must not reintroduce them. */
  mustStayFixed: FeedbackFinding[];
  /** One line per previous attempt, oldest first. */
  history: Array<{ attempt: number; result: string }>;
  notes: string[];
}

const FAILURE_LINE = /^\s*(?:not ok \d+ - .+|✖ .+|.*\berror [A-Z]{2,}\d+: .+|FAIL(?:ED)?\b.+)$/;

/** Failing test names and compiler/build errors, in order of first appearance. */
export function extractFailures(output: string, limit = 40): string[] {
  const found = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (found.size >= limit) break;
    if (FAILURE_LINE.test(line)) found.add(line.trim().slice(0, 300));
  }
  return [...found];
}

/** Keep the start and the end of long output; test runners report failures in either place. */
export function boundOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 4);
  return `${text.slice(0, head)}\n… [${text.length - limit} characters omitted] …\n${text.slice(text.length - (limit - head))}`;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

function failedChecks(attempt: AttemptRecord): FailedCheck[] {
  const verification = record(attempt.verification);
  if (verification.passed !== false) return [];
  const checks = record(verification.details).checks;
  if (!Array.isArray(checks)) return [{ command: 'verification', failures: [], excerpt: boundOutput(JSON.stringify(verification.details ?? null), 4000) }];
  return checks.map(record).filter(check => check.passed === false).map(check => {
    const output = [text(check.stdout), text(check.stderr)].filter(Boolean).join('\n');
    // The node test runner repeats every failure in detail after this marker.
    const marker = output.lastIndexOf('failing tests:');
    return {
      command: text(check.command) ?? 'unknown command',
      failures: Array.isArray(check.failures) ? check.failures.filter((line): line is string => typeof line === 'string') : extractFailures(output),
      excerpt: marker === -1 ? boundOutput(output, 6000) : output.slice(marker, marker + 6000),
      ...(text(check.logFile) ? { logFile: text(check.logFile) } : {})
    };
  });
}

function blockingFindings(attempt: AttemptRecord): FeedbackFinding[] {
  return (attempt.reviews ?? []).filter(review => review.verdict !== 'approved').flatMap(review => {
    const report = record(review.report);
    const findings = (Array.isArray(report.findings) ? report.findings : []).map(record).filter(finding => finding.severity === 'blocking' && text(finding.description));
    // A rejection without a usable blocking finding still has to reach the implementer.
    if (!findings.length) return [{ reviewer: review.reviewer, attempt: attempt.number, description: text(report.summary) ?? `${review.reviewer} review returned ${review.verdict} without findings` }];
    return findings.map(finding => ({
      reviewer: review.reviewer, attempt: attempt.number,
      ...(text(finding.file) ? { file: text(finding.file) } : {}),
      ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
      description: text(finding.description)!,
      ...(text(finding.evidence) ? { evidence: text(finding.evidence) } : {}),
      ...(text(finding.requiredAction) ? { requiredAction: text(finding.requiredAction) } : {})
    }));
  });
}

function uiEvidenceIssues(attempt: AttemptRecord): string[] {
  if (!attempt.uiEvidence || attempt.uiEvidence.passed) return [];
  return [...attempt.uiEvidence.issues, ...(attempt.uiEvidence.manifest?.checks ?? []).filter(check => check.status === 'failed')
    .map(check => `Failed ${check.kind} check "${check.name}"${check.details ? `: ${check.details}` : ''}`)];
}

function reason(attempt: AttemptRecord): string {
  if (attempt.outcome === 'blocked') return 'Implementer reported blocked';
  if (attempt.outcome === 'failed') return 'Implementer reported failed';
  if (attempt.outcome === 'interrupted') return 'Execution was interrupted';
  if (record(attempt.verification).passed === false) return 'Deterministic verification failed';
  if (attempt.uiEvidence && !attempt.uiEvidence.passed) return 'UI evidence was rejected';
  if ((attempt.reviews ?? []).some(review => review.verdict === 'blocked')) return 'A reviewer blocked the task';
  if ((attempt.reviews ?? []).some(review => review.verdict === 'changes_requested')) return 'Review requested changes';
  if (attempt.outcome === 'error') return 'Agent or infrastructure error';
  return 'No recorded rejection';
}

function summary(attempt: AttemptRecord): string {
  const reviews = (attempt.reviews ?? []).map(review => `${review.reviewer}: ${review.verdict}`).join(', ');
  const verification = record(attempt.verification).passed;
  return [reason(attempt), verification === undefined ? undefined : `verification ${verification ? 'passed' : 'failed'}`, reviews || undefined].filter(Boolean).join('; ');
}

/** An attempt that says something about the work, as opposed to a failed agent process. */
const substantive = (attempt: AttemptRecord): boolean => attempt.outcome === 'blocked' || attempt.outcome === 'failed' || attempt.outcome === 'interrupted'
  || attempt.verification !== undefined || !!attempt.reviews?.length || attempt.uiEvidence !== undefined;

/**
 * Structured feedback for a fresh repair session, built only from persisted attempt records.
 * Report contents are agent-authored and untrusted; this selects and labels them, it does not verify them.
 */
export function buildAttemptFeedback(previous: AttemptRecord[]): AttemptFeedback | undefined {
  if (!previous.length) return undefined;
  const latest = [...previous].reverse().find(substantive) ?? previous[previous.length - 1];
  // A finding is settled only by a later review. Until one happens, the last reviewed attempt's findings stay open.
  const reviewed = [...previous].reverse().find(attempt => attempt.reviews?.length);
  const report = record(latest.implementationReport);
  const reported = latest.outcome !== 'implemented';
  const notes = previous.flatMap(attempt => [
    ...(attempt.infraRetry ? [`Attempt ${attempt.number}: ${attempt.infraRetry.role} process failed (${attempt.infraRetry.error}). Inspect the worktree and continue any remaining edits; keep work tightly scoped to the task.`] : []),
    ...(attempt.outcome === 'interrupted' ? [`Attempt ${attempt.number} was interrupted. Inspect the worktree; edits may be partial.`] : [])
  ]);
  return {
    open: {
      attempt: latest.number, reason: reason(latest),
      failedChecks: failedChecks(latest), findings: reviewed ? blockingFindings(reviewed) : [], uiEvidenceIssues: uiEvidenceIssues(latest),
      ...(reported && text(report.summary) ? { implementerSummary: text(report.summary) } : {}),
      ...(reported && Array.isArray(report.blockers) && report.blockers.length ? { blockers: report.blockers } : {})
    },
    mustStayFixed: previous.filter(attempt => reviewed !== undefined && attempt.number < reviewed.number).flatMap(blockingFindings),
    history: previous.map(attempt => ({ attempt: attempt.number, result: summary(attempt) })),
    notes
  };
}
