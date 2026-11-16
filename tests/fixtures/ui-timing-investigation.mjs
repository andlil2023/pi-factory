import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ContractValidator } from '../../src/contract-validator.ts';
const tmp = await mkdtemp(join(tmpdir(), 'ui-timing-'));
try {
  const repo = join(tmp, 'repo'); await mkdir(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: repo });
  let source = await readFile('src/ui-evidence.ts', 'utf8');
  source = source.replace("'./contract-validator.ts'", JSON.stringify(pathToFileURL(resolve('src/contract-validator.ts')).href));
  const marker = '    const ended = Date.now();';
  if (!source.includes(marker)) throw new Error('Collection boundary marker not found');
  source = source.replace(marker, marker + '\n    globalThis.__timings.push({ started, ended });');
  const instrumented = join(tmp, 'ui-evidence.ts'); await writeFile(instrumented, source);
  const { collectUiEvidence } = await import(pathToFileURL(instrumented).href);
  const validator = new ContractValidator(resolve('contracts'));
  globalThis.__timings = [];
  for (let i = 0; i < 100; i++) {
    const record = await collectUiEvidence({ directory: join(tmp, 'evidence'), command: { executable: process.execPath, args: [resolve('tests/fixtures/fake-ui-collector.mjs')] } }, { repository: repo, taskId: 'T001', attempt: 1 }, validator);
    const t = globalThis.__timings[i];
    console.log(JSON.stringify({i, ...t, capturedAt: record.manifest?.capturedAt, passed: record.passed, issues: record.issues, fromStart: Date.parse(record.manifest?.capturedAt) - t.started, fromEnd: Date.parse(record.manifest?.capturedAt) - t.ended}));
  }
} finally { await rm(tmp, {recursive:true, force:true}); }
