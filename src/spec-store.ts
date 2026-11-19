import { defaultSpecificationStore, type SpecificationsConfig } from './spec-config.ts';
import { LocalSpecificationStore } from './spec-store-local.ts';

export interface StoredSpecification { id: string; title: string; text: string; url?: string }
export type Startable = { ok: true } | { ok: false; reason: string };
export interface SpecificationStore {
  readonly kind: 'local' | 'github';
  save(title: string, text: string): Promise<{ id: string; url?: string }>;
  fetch(id: string): Promise<StoredSpecification>;
  startable(id: string): Promise<Startable>;
}

export async function createSpecificationStore(config: SpecificationsConfig | undefined, repository: string): Promise<SpecificationStore> {
  const kind = config?.store ?? defaultSpecificationStore;
  if (kind === 'github') throw new Error('GitHub specification store is not available yet.');
  if (kind !== 'local') throw new Error(`Unknown specification store: ${kind}`);
  return new LocalSpecificationStore(repository, config?.local?.directory);
}
