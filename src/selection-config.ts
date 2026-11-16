/** Opt-in repository-relative, segment-prefix rules. Command references are zero-based
 * indexes into the operator-owned verification array; no command text comes from tasks. */
export interface SelectionConfig {
  rules: Array<{ path: string; commands: number[] }>;
}

type VerificationCommand = { executable: string; args?: string[]; timeoutMs?: number };

export function validateSelectionConfig(selection: unknown, verification: unknown): asserts selection is SelectionConfig {
  const invalid = (detail: string): never => { throw new Error(`Invalid verificationSelection: ${detail}`); };
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(selection) || Object.keys(selection).some(key => key !== 'rules') || !Array.isArray(selection.rules) || !selection.rules.length) return invalid('expected non-empty rules');
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
    if (!object(rule) || Object.keys(rule).some(key => key !== 'path' && key !== 'commands') || typeof rule.path !== 'string'
      || !rule.path || rule.path !== rule.path.trim() || /[\\:*?\[\]\x00-\x1f\x7f]/.test(rule.path)
      || rule.path.split('/').some(part => !part || part === '.' || part === '..')) return invalid('malformed repository-relative path rule');
    const path = rule.path;
    if (paths.some(previous => previous === path || previous.startsWith(path + '/') || path.startsWith(previous + '/'))) return invalid('overlapping path rules');
    paths.push(path);
    if (!Array.isArray(rule.commands) || !rule.commands.length || rule.commands.some((index: unknown) => !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= verification.length)
      || new Set(rule.commands).size !== rule.commands.length) return invalid('invalid or duplicate command references');
  }
}
