export const IMPACT_ESTIMATE_LINE = '_Initial estimate, generated before implementation. Not a requirement and not a limit on the implementation._';

export interface ImpactReport {
  affectedModules: Array<{ path: string; change: string }>;
  consequences: string[];
}

// Keep each estimate on one line even if a caller supplies unexpected whitespace.
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function renderImpact(report: ImpactReport): string {
  const areas = report.affectedModules.map(({ path, change }) => `- \`${oneLine(path)}\`: ${oneLine(change)}`);
  const consequences = report.consequences.map(consequence => `- ${oneLine(consequence)}`);
  return [
    IMPACT_ESTIMATE_LINE,
    '',
    '### Likely affected areas',
    ...(areas.length ? areas : ['- None identified.']),
    '',
    '### Likely consequences',
    ...(consequences.length ? consequences : ['- None identified.']),
  ].join('\n');
}
