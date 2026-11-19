import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultIterationField, defaultSpecificationLabel, defaultSpecificationStore, validateSpecificationsConfig, type SpecificationsConfig } from './spec-config.ts';
import { githubRepository } from './github-pr.ts';
import { GitHubSpecificationStore, ghRunner, type GhRunner } from './spec-store-github.ts';
import { LocalSpecificationStore } from './spec-store-local.ts';

export interface StoredSpecification { id: string; title: string; text: string; url?: string; updatedAt?: string }
export type Startable = { ok: true } | { ok: false; reason: string };
export interface SpecificationStore {
  readonly kind: 'local' | 'github';
  save(title: string, text: string): Promise<{ id: string; url?: string }>;
  fetch(id: string): Promise<StoredSpecification>;
  startable(id: string): Promise<Startable>;
}

export async function createSpecificationStore(config: SpecificationsConfig | undefined, repository: string, gh?: GhRunner): Promise<SpecificationStore> {
  const kind = config?.store ?? defaultSpecificationStore;
  if (kind === 'github') {
    validateSpecificationsConfig(config);
    const github = config!.github!;
    let target = github.repository;
    if (!target) {
      try {
        const { stdout } = await promisify(execFile)('git', ['remote', 'get-url', 'origin'], { cwd: repository, windowsHide: true });
        target = githubRepository(stdout.trim());
      } catch {
        throw new Error('Cannot derive specifications.github.repository from origin; configure specifications.github.repository explicitly.');
      }
    }
    const project = github.project!;
    return new GitHubSpecificationStore({ repository: target, label: github.label ?? defaultSpecificationLabel, project: { ...project, iterationField: project.iterationField ?? defaultIterationField }, gh: gh ?? ghRunner(repository) });
  }
  if (kind !== 'local') throw new Error(`Unknown specification store: ${kind}`);
  return new LocalSpecificationStore(repository, config?.local?.directory);
}
