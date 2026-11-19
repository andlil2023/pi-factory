import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const factoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Initialize only the selected target; existing files are kept unless forced. */
export async function initialize(targetPath: string, force = false): Promise<void> {
  const target = resolve(targetPath);
  async function copyIfMissing(from: string, to: string): Promise<void> {
    const contents = await readFile(from, 'utf8');
    try {
      await writeFile(to, contents, { flag: force ? 'w' : 'wx' });
      console.log(`WRITE ${to}`);
    } catch (error) {
      if (!force && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        console.log(`KEEP ${to}`);
        return;
      }
      throw error;
    }
  }
  await mkdir(join(target, '.factory'), { recursive: true });
  await copyIfMissing(join(factoryRoot, 'factory.config.example.json'), join(target, '.factory', 'config.json'));
  await copyIfMissing(join(factoryRoot, 'examples', 'objective.md'), join(target, '.factory', 'objective.md'));
  await copyIfMissing(join(factoryRoot, 'templates', 'specification.md'), join(target, '.factory', 'specification-template.md'));
  console.log('Initialized target project. Edit .factory/config.json and .factory/objective.md.');
}

// Preserve the existing checkout initialization scripts and their positional target.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await initialize(process.argv[2] ?? '.', process.argv.includes('--force'));
}
