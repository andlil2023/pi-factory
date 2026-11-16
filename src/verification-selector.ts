import type { GitChangeEvidence } from './git-change-evidence.ts';
import { validateSelectionConfig, type SelectionConfig } from './selection-config.ts';

export interface VerificationCommand {
  executable: string;
  args?: string[];
  timeoutMs?: number;
}

export interface VerificationSelection<T extends VerificationCommand = VerificationCommand> {
  mode: 'full' | 'selected';
  evidence: GitChangeEvidence;
  commands: T[];
  reasons: string[];
}

/** Select only from operator-owned commands and declarations. Evidence is cumulative
 * against the accepted-task baseline; collecting it is the caller's responsibility. */
export function selectVerification<T extends VerificationCommand>(
  verification: T[], selection: SelectionConfig | undefined, evidence: GitChangeEvidence,
): VerificationSelection<T> {
  const full = (reasons: string[]): VerificationSelection<T> => ({ mode: 'full', evidence, commands: [...verification], reasons });
  if (!selection) return full(['Verification selection is not configured']);
  try {
    validateSelectionConfig(selection, verification);
  } catch {
    return full(['Invalid verification selection declaration']);
  }
  if (selection.dependenciesComprehensive !== true || !selection.dependencyPaths) {
    return full(['Verification dependencies are not declared comprehensive']);
  }
  if (!evidence.suitable || evidence.reasons.length || !evidence.changes.length) {
    return full(['Change evidence is unsuitable', ...evidence.reasons]);
  }
  const matches = (path: string, prefix: string): boolean => path === prefix || path.startsWith(prefix + '/');
  const selected = new Set<number>();
  const reasons: string[] = [];
  for (const change of evidence.changes) {
    // Defend against inconsistent evidence, not just the collector's suitability flag.
    if (!change.path || change.path.split('/').some(part => !part || part === '.' || part === '..')
      || change.path.includes('\\') || change.previousPath !== undefined
      || !(['committed', 'staged', 'unstaged'].includes(change.source) && ['A', 'M'].includes(change.status)
        || change.source === 'untracked' && change.status === '?')) {
      return full([`Unsupported change evidence: ${change.path}`]);
    }
    const dependency = selection.dependencyPaths.find(path => matches(change.path, path));
    if (dependency) return full([`Changed verification dependency: ${change.path} (declared ${dependency})`]);
    const rule = selection.rules.find(candidate => matches(change.path, candidate.path));
    if (!rule) return full([`No verification mapping for changed path: ${change.path}`]);
    for (const index of rule.commands) selected.add(index);
    reasons.push(`Mapped ${change.path} to ${rule.path}`);
  }
  return { mode: 'selected', evidence, commands: verification.filter((_, index) => selected.has(index)), reasons };
}
