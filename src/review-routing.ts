import type { PlannedTask } from './orchestrator.ts';

export type ReviewRouting = 'all' | 'task-specific';
export interface ReviewSelection {
  requiredReviewers: string[];
  changedFiles: string[];
  reasons: string[];
}

/** Trusted routing rules. Agent-authored text can add requirements, never waive them. */
export function selectTaskReviewers(task: PlannedTask, changedFiles: string[], enabled: readonly string[], mode: ReviewRouting = 'all'): ReviewSelection {
  if (mode !== 'all' && mode !== 'task-specific') throw new Error('Invalid reviewRouting; use all or task-specific');
  const required = new Set(['code']);
  const reasons: string[] = ['Code review is always required'];
  const add = (ids: readonly string[], reason: string) => {
    for (const id of ids) if (enabled.includes(id)) required.add(id);
    reasons.push(reason);
  };
  if (mode === 'all') add(enabled, 'All enabled reviewers required by configuration');
  else {
    if (!changedFiles.length) add(enabled, 'No changed paths: scope is uncertain');
    for (const original of changedFiles) {
      const path = original.replaceAll('\\', '/').toLowerCase();
      const security = /auth|permission|secret|credential|session|token|crypto|security|(?:^|[/_.-])(?:api|server|backend|database|db|migration|schema|sql|data)(?:[/_.-]|$)/.test(path);
      const ui = /(?:^|[/_.-])(?:ui|gui|frontend|components?|pages?|views?|layouts?|styles?|assets?)(?:[/_.-]|$)|\.(?:tsx|jsx|vue|svelte|xaml|html|css|scss|sass|less)$/.test(path);
      const documentation = /\.(?:md|txt|rst)$/.test(path);
      if (security) add(['security'], `Security-sensitive path: ${original}`);
      if (ui) add(['ui'], `UI path: ${original}`);
      // Executable source/configuration may change trust boundaries even in UI code.
      if (!documentation && !/\.(?:png|jpe?g|gif|webp|ico|css|scss|sass|less)$/.test(path)) {
        add(['security'], `Source, configuration, or unknown artifact: ${original}`);
      }
      // An unclassified path may cross a trust boundary, but it is not evidence of a user interface:
      // the UI reviewer is selected by UI paths or UI task text only.
      if (!security && !ui && !documentation) add(enabled.filter(id => id !== 'ui'), `Ambiguous path: ${original}`);
    }
    const text = [task.title, task.objective, task.scope, ...task.acceptanceCriteria, ...task.verification].join(' ');
    if (/\b(auth\w*|permission\w*|secret\w*|credential\w*|secur\w*|api|database|migration\w*|data|injection|encrypt\w*)\b/i.test(text)) add(['security'], 'Task text indicates security, API, or data scope');
    if (/\b(ui|gui|frontend|front-end|visual|browser|accessibility|a11y|component\w*|layout\w*|screen\w*|css)\b/i.test(text)) add(['ui'], 'Task text indicates UI or accessibility scope');
  }
  return { requiredReviewers: ['code', ...enabled.filter(id => id !== 'code' && required.has(id))], changedFiles: [...new Set(changedFiles)].sort(), reasons };
}
