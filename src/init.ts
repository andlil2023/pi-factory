import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const factoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = resolve(process.argv[2] ?? '.');
const force = process.argv.includes('--force');
async function copyIfMissing(from: string, to: string) {
  try { await access(to); if (!force) { console.log(`KEEP ${to}`); return; } } catch { /* missing */ }
  await writeFile(to, await readFile(from, 'utf8'));
  console.log(`WRITE ${to}`);
}
await mkdir(target, { recursive: true });
await mkdir(join(target, '.factory'), { recursive: true });
await copyIfMissing(join(factoryRoot, 'factory.config.example.json'), join(target, '.factory', 'config.json'));
await copyIfMissing(join(factoryRoot, 'examples', 'objective.md'), join(target, '.factory', 'objective.md'));
console.log('Initialized target project. Edit .factory/config.json and .factory/objective.md.');
