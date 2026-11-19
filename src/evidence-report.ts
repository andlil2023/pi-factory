import type { FactoryRunState } from './state-store.ts';
import type { PlannedTask } from './orchestrator.ts';
import { planIdentity, type NamedObservation, type VerificationIdentity } from './verification-observations.ts';

export interface EvidenceReport {
  runId: string;
  identity: { plan: string; specification: string | null; implementation: string | null };
  summary: string;
  verification: 'passed' | 'failed' | 'unavailable';
  gaps: string[];
  criteria: Array<{ taskId: string; criterion: number; expected: string; status: 'demonstrated' | 'failed' | 'not demonstrated'; observed: string; evidence: string[] }>;
}

/** Only observations from final verification (or its explicitly reused attempt) are considered. */
export function buildEvidenceReport(state: FactoryRunState, implementation: string | null): EvidenceReport {
  const plan = state.plan as { objective?: string; tasks?: PlannedTask[] } | null;
  const identity = { plan: planIdentity(state.plan), specification: state.specification?.sha256 ?? null, implementation };
  const final = state.finalVerification;
  let details = final?.details as { observations?: unknown; reused?: { from?: string; taskId?: string; attempt?: number } } | undefined;
  if (details?.reused?.from === 'task verification') {
    const reused = details.reused;
    const attempt = reused.taskId ? state.tasks[reused.taskId]?.attempts.find(a => a.number === reused.attempt) : undefined;
    details = (attempt?.verification as { details?: typeof details } | undefined)?.details;
  }
  const observations: NamedObservation[] = Array.isArray(details?.observations) ? details.observations : [];
  const criteria: EvidenceReport['criteria'] = [];
  for (const task of plan?.tasks ?? []) for (const [criterion, expected] of task.acceptanceCriteria.entries()) {
    const mappings = (task.criterionChecks ?? []).filter(m => m.criterion === criterion);
    const names = mappings.length === 1 && mappings[0].checks.length && new Set(mappings[0].checks).size === mappings[0].checks.length ? mappings[0].checks : [];
    const evidence: string[] = [];
    let missing = !names.length;
    let failed = false;
    for (const name of names) {
      const matches = observations.filter(o => o && o.name === name);
      // Multiple observations are only resolvable when they form one complete rerun chain.
      // Legacy single observations remain usable; unrelated duplicates stay ambiguous.
      if (!matches.length || (matches.length > 1 && !matches.every((o, i) =>
        o.execution && Number.isSafeInteger(o.execution.commandIndex) && o.execution.commandIndex >= 0 &&
        o.execution.commandIndex === matches[0].execution?.commandIndex && o.execution.rerun === i &&
        (i === matches.length - 1 || o.passed === false) &&
        JSON.stringify(o.identity) === JSON.stringify(matches[0].identity)))) { missing = true; continue; }
      if (matches.length === 1 && matches[0].execution && matches[0].execution.rerun !== 0) { missing = true; continue; }
      const observation = matches[matches.length - 1];
      const observedIdentity: VerificationIdentity | null = observation.identity;
      if (!implementation || !observedIdentity || observedIdentity.plan !== identity.plan || observedIdentity.specification !== identity.specification || observedIdentity.implementation !== implementation || typeof observation.passed !== 'boolean') { missing = true; continue; }
      evidence.push(`Named check ${name}: ${observation.passed ? 'passed' : 'failed'}.`);
      if (!observation.passed) failed = true;
    }
    const status = failed ? 'failed' : missing ? 'not demonstrated' : 'demonstrated';
    const observed = status === 'failed' ? 'A matching named check failed.' : status === 'demonstrated' ? 'All mapped named checks passed.' : 'Matching unambiguous current evidence is unavailable.';
    if (missing) evidence.push('Gap: a mapping or current unambiguous named observation is missing.');
    criteria.push({ taskId: task.id, criterion, expected, status, observed, evidence });
  }
  const objective = (typeof plan?.objective === 'string' ? plan.objective : 'Changes for this run').trim().replace(/\s+/g, ' ');
  const sentence = objective.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? `${objective.replace(/[.!?]+$/, '')}.`;
  return { runId: state.runId, identity, summary: sentence, verification: final ? (final.passed ? 'passed' : 'failed') : 'unavailable', gaps: criteria.filter(c => c.status === 'not demonstrated').map(c => `${c.taskId} criterion ${c.criterion + 1}: ${c.observed}`), criteria };
}
