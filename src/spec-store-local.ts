import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defaultSpecificationDirectory, validateSpecificationsConfig } from './spec-config.ts';
import { parseSpecification } from './spec-format.ts';
import type { SpecificationStore, StoredSpecification, Startable } from './spec-store.ts';

export class LocalSpecificationStore implements SpecificationStore {
  readonly kind = 'local' as const;
  private readonly repository: string;
  private readonly directory: string;

  constructor(repository: string, directory = defaultSpecificationDirectory) {
    validateSpecificationsConfig({ local: { directory } });
    this.repository = resolve(repository);
    this.directory = directory;
  }

  async save(title: string, text: string): Promise<{ id: string }> {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
      || `spec-${createHash('sha256').update(title).digest('hex').slice(0, 48)}`;
    const path = resolve(this.repository, this.directory, `${slug}.md`);
    const id = relative(this.repository, path).split(sep).join('/');
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Specification already exists: ${id}`);
      throw error;
    }
    return { id };
  }

  async fetch(id: string): Promise<StoredSpecification> {
    const path = isAbsolute(id) ? id : join(this.repository, id);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Specification not found: ${id}`);
      throw error;
    }
    return { id, title: parseSpecification(text).title, text };
  }

  async startable(_id: string): Promise<Startable> { return { ok: true }; }
}
