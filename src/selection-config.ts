/** Opt-in repository-relative, segment-prefix rules. Command references are zero-based
 * indexes into the operator-owned verification array; no command text comes from tasks. */
export interface SelectionConfig {
  rules: Array<{ path: string; commands: number[] }>;
  /** Repository-relative file or directory prefixes affecting verification. */
  dependencyPaths?: string[];
  /** Explicit operator assertion that dependencyPaths covers all verification dependencies. */
  dependenciesComprehensive?: boolean;
}

type VerificationCommand = { executable: string; args?: string[]; timeoutMs?: number };

export function validateSelectionConfig(selection: unknown, verification: unknown): asserts selection is SelectionConfig {
  const invalid = (detail: string): never => { throw new Error(`Invalid verificationSelection: ${detail}`); };
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(selection) || Object.keys(selection).some(key => key !== 'rules' && key !== 'dependencyPaths' && key !== 'dependenciesComprehensive') || !Array.isArray(selection.rules) || !selection.rules.length) return invalid('expected non-empty rules');
  const validPath = (path: unknown): path is string => typeof path === 'string' && !!path && path === path.trim()
    && !/[\\:*?\[\]\x00-\x1f\x7f]/.test(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..');
  if (selection.dependenciesComprehensive !== undefined && typeof selection.dependenciesComprehensive !== 'boolean') return invalid('dependenciesComprehensive must be a boolean');
  if (selection.dependencyPaths !== undefined && (!Array.isArray(selection.dependencyPaths)
    || selection.dependencyPaths.some((path: unknown) => !validPath(path))
    || new Set(selection.dependencyPaths).size !== selection.dependencyPaths.length)) return invalid('malformed or duplicate dependency paths');
  if (selection.dependenciesComprehensive === true && !Array.isArray(selection.dependencyPaths)) return invalid('comprehensive dependencies require dependencyPaths');
  if (!Array.isArray(verification) || !verification.length) return invalid('requires configured verification commands');
  const signatures = new Set<string>();
  for (const command of verification) {
    if (!object(command) || typeof command.executable !== 'string' || !command.executable.trim()
      || (command.args !== undefined && (!Array.isArray(command.args) || command.args.some((arg: unknown) => typeof arg !== 'string')))
      || (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || (command.timeoutMs as number) <= 0))) return invalid('malformed verification command');
    const c = command as VerificationCommand;
    const signature = JSON.stringify([c.executable, c.args ?? [], c.timeoutMs ?? 120000]);
    if (signatures.has(signature)) return invalid('duplicate verification commands are ambiguous');
    signatures.add(signature);
  }
  const paths: string[] = [];
  for (const rule of selection.rules) {
    if (!object(rule) || Object.keys(rule).some(key => key !== 'path' && key !== 'commands') || !validPath(rule.path)) return invalid('malformed repository-relative path rule');
    const path = rule.path;
    // Nested rules are allowed: the most specific rule decides (see selectVerification).
    if (paths.includes(path)) return invalid('duplicate path rules');
    paths.push(path);
    if (!Array.isArray(rule.commands) || !rule.commands.length || rule.commands.some((index: unknown) => !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= verification.length)
      || new Set(rule.commands).size !== rule.commands.length) return invalid('invalid or duplicate command references');
  }
}
