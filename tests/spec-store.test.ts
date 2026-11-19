import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpecificationStore } from '../src/spec-store.ts';
import { LocalSpecificationStore } from '../src/spec-store-local.ts';

test('local store saves without overwriting and fetches exact text by either path', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'spec-store-'));
  try {
    const store = await createSpecificationStore(undefined, repo);
    assert.equal(store.kind, 'local');
    const text = '```\r\n# Not the title\r\n```\r\n# Real Title\r\n\r\nContent\r\n';
    const { id } = await store.save('Add Webhook Delivery!', text);
    assert.equal(id, '.factory/specs/add-webhook-delivery.md');
    assert.equal(await readFile(join(repo, id), 'utf8'), text);
    await assert.rejects(store.save('Add Webhook Delivery!', 'replacement'), /already exists: .*add-webhook-delivery\.md/);
    assert.equal(await readFile(join(repo, id), 'utf8'), text);
    assert.deepEqual(await store.fetch(id), { id, title: 'Real Title', text });
    const absolute = join(repo, id);
    assert.deepEqual(await store.fetch(absolute), { id: absolute, title: 'Real Title', text });
    assert.deepEqual(await store.startable('anything'), { ok: true });
    await assert.rejects(store.fetch('missing.md'), /Specification not found: missing\.md/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('local store uses safe deterministic fallback names without overwriting', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'spec-store-'));
  try {
    const store = new LocalSpecificationStore(repo);
    const titles = ['日本語', '???', '', '🎉'];
    const ids = new Set<string>();
    for (const title of titles) {
      const { id } = await store.save(title, title);
      assert.match(id, /^\.factory\/specs\/spec-[a-f0-9]{48}\.md$/);
      assert.ok(!ids.has(id));
      ids.add(id);
      await assert.rejects(store.save(title, 'replacement'), /already exists/);
      assert.equal(await readFile(join(repo, id), 'utf8'), title);
    }
    // An existing ASCII slug can also occupy a fallback path.
    const fallbackSlug = [...ids][0].split('/').pop()!.replace(/\.md$/, '');
    await assert.rejects(store.save(fallbackSlug, 'replacement'), /already exists/);
    assert.equal(await readFile(join(repo, [...ids][0]), 'utf8'), titles[0]);
    assert.equal((await store.save('  Hello, WORLD!  ', 'text')).id, '.factory/specs/hello-world.md');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('custom directory, concurrent saves, and configured GitHub selection', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'spec-store-'));
  try {
    const store = await createSpecificationStore({ store: 'local', local: { directory: 'docs/specs' } }, repo);
    const results = await Promise.allSettled([store.save('Same', 'first'), store.save('Same', 'second')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.ok(['first', 'second'].includes(await readFile(join(repo, 'docs/specs/same.md'), 'utf8')));
    await writeFile(join(repo, 'outside.md'), '# Outside\n');
    assert.equal((await new LocalSpecificationStore(repo).fetch('outside.md')).title, 'Outside');
    assert.throws(() => new LocalSpecificationStore(repo, '../outside'), /specifications.local.directory/);
    await assert.rejects(createSpecificationStore({ store: 'github' }, repo), /not available yet/i);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
