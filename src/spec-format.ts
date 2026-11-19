export const REQUIRED_SECTIONS = ['What', 'Why', 'Acceptance criteria', 'Out of scope', 'Threat model', 'Open questions'] as const;

export interface SpecIssue { section: string; message: string }
export interface ParsedSpecification {
  title: string;
  sections: Array<{ heading: string; body: string }>;
  hasImpactAnalysis: boolean;
}

interface ScanResult {
  titles: string[];
  sections: Array<{ heading: string; body: string; contentLines: string[] }>;
}

// Keep fenced lines in the body, but never interpret them as headings or list items.
function scan(text: string): ScanResult {
  const titles: string[] = [];
  const sections: ScanResult['sections'] = [];
  let current: { heading: string; lines: string[]; contentLines: string[] } | undefined;
  let fence: { character: string; length: number } | undefined;
  const finish = () => {
    if (current) sections.push({ heading: current.heading, body: current.lines.join('\n').trim(), contentLines: current.contentLines });
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      current?.lines.push(line);
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) fence = undefined;
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      current?.lines.push(line);
      continue;
    }
    const title = line.match(/^#(?:[ \t]+(.*)|[ \t]*)$/);
    if (title) {
      titles.push((title[1] ?? '').trim());
      continue;
    }
    const heading = line.match(/^##(?:[ \t]+(.*)|[ \t]*)$/);
    if (heading) {
      finish();
      current = { heading: (heading[1] ?? '').trim(), lines: [], contentLines: [] };
      continue;
    }
    current?.lines.push(line);
    current?.contentLines.push(line);
  }
  finish();
  return { titles, sections };
}

export function parseSpecification(text: string): ParsedSpecification {
  const parsed = scan(text);
  return {
    title: parsed.titles[0] ?? '',
    sections: parsed.sections.map(({ heading, body }) => ({ heading, body })),
    hasImpactAnalysis: parsed.sections.some(section => section.heading.toLowerCase() === 'impact analysis'),
  };
}

export function validateSpecification(text: string, options: { allowOpenQuestions?: boolean } = {}): SpecIssue[] {
  const parsed = scan(text);
  const issues: SpecIssue[] = [];
  if (parsed.titles.length === 0) issues.push({ section: 'Title', message: 'Title is missing.' });
  else if (parsed.titles.length > 1) issues.push({ section: 'Title', message: 'More than one title.' });
  if (parsed.titles.length > 0 && parsed.titles.some(title => !title)) issues.push({ section: 'Title', message: 'Title is empty.' });

  for (const name of REQUIRED_SECTIONS) {
    const matches = parsed.sections.filter(section => section.heading.toLowerCase() === name.toLowerCase());
    if (matches.length === 0) {
      issues.push({ section: name, message: 'Section is missing.' });
      continue;
    }
    if (matches.length > 1) issues.push({ section: name, message: 'Section appears more than once.' });
    if (matches.some(section => !section.body.trim())) {
      issues.push({ section: name, message: 'Section is empty.' });
      continue;
    }
    if (name === 'Acceptance criteria' && matches.some(section => !section.contentLines.some(line => /^\s*(?:[-+*]|\d+[.)])\s+\S/.test(line)))) {
      issues.push({ section: name, message: 'Add at least one list item.' });
    }
    if (name === 'Open questions' && !options.allowOpenQuestions && matches.some(section => !/^none\.?$/i.test(section.body.trim()))) {
      issues.push({ section: name, message: 'Open questions must be resolved; the section must read "None".' });
    }
  }
  return issues;
}
