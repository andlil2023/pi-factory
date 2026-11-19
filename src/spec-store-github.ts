import { spawn } from 'node:child_process';
import type { SpecificationStore, StoredSpecification, Startable } from './spec-store.ts';

export type GhRunner = (args: string[], input?: string) => Promise<string>;
export interface GitHubStoreOptions {
  repository: string;
  label: string;
  project: { owner: string; number: number; iterationField: string };
  gh: GhRunner;
  today?: () => Date;
}

export function ghRunner(cwd: string, spawnProcess: typeof spawn = spawn): GhRunner {
  return (args, input) => new Promise((resolve, reject) => {
    const child = spawnProcess('gh', args, { cwd, windowsHide: true, shell: false, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let tooLarge = false;
    for (const [stream, append] of [[child.stdout, (s: string) => { stdout += s; }], [child.stderr, (s: string) => { stderr += s; }]] as const) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 4 * 1024 * 1024) { tooLarge = true; child.kill(); }
        else append(chunk);
      });
    }
    child.on('error', reject);
    child.stdin.on('error', () => {}); // The process may exit before consuming stdin.
    child.on('close', code => {
      if (tooLarge) reject(new Error('gh output exceeded 4 MiB'));
      else if (code !== 0) reject(new Error(stderr.trim() || `gh exited with code ${code}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

function bodyWithoutTitle(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let fence: { character: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) fence = undefined;
    } else if (marker) fence = { character: marker[1][0], length: marker[1].length };
    else if (/^#(?:[ \t]+.*|[ \t]*)$/.test(lines[i])) { lines.splice(i, 1); break; }
  }
  return lines.join('\n').trim();
}

export class GitHubSpecificationStore implements SpecificationStore {
  readonly kind = 'github' as const;
  readonly options: GitHubStoreOptions;
  constructor(options: GitHubStoreOptions) { this.options = options; }

  async save(title: string, text: string): Promise<{ id: string; url: string }> {
    const { repository, label, gh } = this.options;
    let url: string;
    try {
      url = (await gh(['issue', 'create', '--repo', repository, '--title', title, '--label', label, '--body-file', '-'], bodyWithoutTitle(text))).trim();
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop()?.slice(0, 300) || 'gh failed';
      const hint = /label/i.test(message) && /not found|does not exist|could not resolve/i.test(message) ? ` Create the label "${label}" in ${repository} first.` : '';
      throw new Error(message + hint);
    }
    const prefix = `https://github.com/${repository}/issues/`;
    const id = url.slice(prefix.length);
    if (url.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase() || !/^[1-9][0-9]*$/.test(id)) throw new Error('GitHub returned an unexpected issue URL');
    return { id, url };
  }

  async fetch(id: string): Promise<StoredSpecification> {
    if (/[^0-9]/.test(id) || !/[1-9]/.test(id)) throw new Error(`Invalid GitHub issue id: ${id}`);
    const response = await this.options.gh(['issue', 'view', id, '--repo', this.options.repository, '--json', 'title,body,url,updatedAt']);
    let issue: unknown;
    try { issue = JSON.parse(response); } catch { throw new Error('GitHub returned an unexpected response'); }
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error('GitHub returned an unexpected response');
    const fields = issue as Record<string, unknown>;
    if (typeof fields.title !== 'string' || typeof fields.body !== 'string' || typeof fields.url !== 'string' || typeof fields.updatedAt !== 'string') {
      throw new Error('GitHub returned an unexpected response');
    }
    return { id, title: fields.title, url: fields.url, updatedAt: fields.updatedAt, text: `# ${fields.title}\n\n${fields.body}`.replace(/\r\n/g, '\n') };
  }
  async startable(id: string): Promise<Startable> {
    if (/[^0-9]/.test(id) || !/[1-9]/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) > 2147483647) throw new Error(`Invalid GitHub issue id: ${id}`);
    const { repository, label, project, gh } = this.options;
    const [owner, name] = repository.split('/');
    const query = `query($owner: String!, $name: String!, $number: Int!, $field: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      state
      labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
      projectItems(first: 100) {
        nodes {
          project { number owner { ... on User { login } ... on Organization { login } } }
          fieldValueByName(name: $field) {
            __typename
            ... on ProjectV2ItemFieldIterationValue { title startDate duration }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`;
    const response = await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${Number(id)}`, '-f', `field=${project.iterationField}`]);
    const unexpected = (): never => { throw new Error('GitHub returned an unexpected response'); };
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return unexpected();
      return value as Record<string, unknown>;
    };
    const connection = (value: unknown): unknown[] => {
      const data = object(value);
      if (!Array.isArray(data.nodes) || object(data.pageInfo).hasNextPage !== false) return unexpected();
      return data.nodes;
    };
    let parsed: unknown;
    try { parsed = JSON.parse(response); } catch { return unexpected(); }
    const root = object(parsed);
    if ('errors' in root) return unexpected();
    const issue = object(object(object(root.data).repository).issue);
    if (typeof issue.state !== 'string' || !['OPEN', 'CLOSED'].includes(issue.state)) return unexpected();
    if (issue.state !== 'OPEN') return { ok: false, reason: 'Issue is not open' };
    const labels = connection(issue.labels).map(node => {
      const name = object(node).name;
      if (typeof name !== 'string') return unexpected();
      return name;
    });
    if (!labels.includes(label)) return { ok: false, reason: `Issue is missing label "${label}"` };
    const items = connection(issue.projectItems);
    let foundProject = false;
    for (const node of items) {
      const item = object(node);
      const itemProject = object(item.project);
      const login = object(itemProject.owner).login;
      if (typeof login !== 'string' || !Number.isInteger(itemProject.number)) return unexpected();
      if (login.toLowerCase() !== project.owner.toLowerCase() || itemProject.number !== project.number) continue;
      foundProject = true;
      if (item.fieldValueByName === null) continue;
      const value = object(item.fieldValueByName);
      if (typeof value.__typename !== 'string') return unexpected();
      if (value.__typename !== 'ProjectV2ItemFieldIterationValue') continue;
      if (typeof value.title !== 'string' || typeof value.startDate !== 'string' || typeof value.duration !== 'number' || !Number.isSafeInteger(value.duration) || value.duration <= 0) return unexpected();
      const start = Date.parse(`${value.startDate}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.startDate) || !Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== value.startDate) return unexpected();
      const now = (this.options.today ?? (() => new Date()))();
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      if (!Number.isFinite(today)) return unexpected();
      if (start <= today && today < start + value.duration * 86400000) return { ok: true };
      return { ok: false, reason: `Iteration "${value.title}" is not current` };
    }
    if (!foundProject) return { ok: false, reason: `Issue is not in Project ${project.owner}/${project.number}` };
    return { ok: false, reason: `Issue is missing iteration field "${project.iterationField}" value` };
  }
}
