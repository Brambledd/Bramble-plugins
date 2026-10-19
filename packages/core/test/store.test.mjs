// Acceptance tests for the evidence store core (schema, scan, search, drill,
// cue ledger, rebuild). Fixtures are copied to a temp dir because drill-
// invalidation tests mutate source files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EvidenceStore } from '../src/store.js';
import { indexRoot, rebuildAll } from '../src/scanner.js';
import { EVIDENCE_APPLICATION_ID } from '../src/schema.js';
import { computeRevision } from '../src/util.js';

async function tempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-'));
  const fixtures = join(dir, 'knowledge');
  await cp(new URL('./fixtures', import.meta.url), fixtures, { recursive: true });
  const dbPath = join(dir, 'evidence.sqlite');
  const store = new EvidenceStore(dbPath);
  return { dir, fixtures, dbPath, store };
}

test('fresh database initializes schema, application id and version', () => {
  const store = new EvidenceStore(':memory:');
  try {
    const appId = Number(store.db.prepare('PRAGMA application_id').get().application_id);
    assert.equal(appId, EVIDENCE_APPLICATION_ID);
    const version = Number(store.db.prepare('PRAGMA user_version').get().user_version);
    assert.ok(version >= 1);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const expected of ['evidence_docs', 'evidence_fts', 'cue_episodes', 'indexed_roots']) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
  } finally {
    store.close();
  }
});

test('foreign database is rejected, not silently adopted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-foreign-'));
  const path = join(dir, 'foreign.sqlite');
  const foreign = new DatabaseSync(path);
  foreign.exec('CREATE TABLE unrelated (x TEXT);');
  foreign.close();
  assert.throws(() => new EvidenceStore(path), /another application|not empty/);
  await rm(dir, { recursive: true, force: true });
});

test('stale schema version resets derived tables in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-stale-'));
  const path = join(dir, 'evidence.sqlite');
  {
    const store = new EvidenceStore(path);
    store.upsert({
      anchor: 'note-x',
      kind: 'note',
      status: 'active',
      title: 'x',
      summary: null,
      keywords: [],
      sourcePath: null,
      revision: computeRevision('x'),
      supersededBy: null,
    });
    store.close();
  }
  {
    // Simulate a future/unknown schema: bump user_version beyond current.
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 999;');
    raw.close();
  }
  const store = new EvidenceStore(path);
  try {
    assert.equal(store.resetOnOpen, true);
    assert.equal(store.stats().total, 0, 'derived rows must be reset');
  } finally {
    store.close();
  }
  await rm(dir, { recursive: true, force: true });
});

test('indexRoot scans fixtures with deterministic kinds, anchors and statuses', async () => {
  const ws = await tempWorkspace();
  try {
    const result = await indexRoot(ws.store, ws.fixtures);
    assert.equal(result.scanned, 5);
    assert.deepEqual(result.anchors.sort(), [
      'ADR-001',
      'ADR-002',
      'ADR-003',
      'lessons-lesson-fts5-triggers',
      'notes-note-weekly-meeting',
    ].sort());
    const adr1 = ws.store.getByAnchor('ADR-001');
    assert.equal(adr1.kind, 'decision');
    assert.equal(adr1.status, 'accepted');
    assert.equal(adr1.authority, 'standard');
    // ADR-003 has no explicit status → fail-closed 'captured', never accepted.
    const adr3 = ws.store.getByAnchor('ADR-003');
    assert.equal(adr3.status, 'captured');
    const lesson = ws.store.getByAnchor('lessons-lesson-fts5-triggers');
    assert.equal(lesson.kind, 'lesson');
    assert.equal(lesson.status, 'active');
    // revision equals sha256 of the source file
    const content = await readFile(adr1.sourcePath, 'utf8');
    assert.equal(adr1.revision, computeRevision(content));
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('search: BM25 hits, kind filter, CJK trigram and LIKE fallback, demotion', async () => {
  const ws = await tempWorkspace();
  try {
    await indexRoot(ws.store, ws.fixtures);
    // english BM25
    const sqlite = ws.store.search({ query: 'sqlite driver' });
    assert.ok(sqlite.items.length >= 1);
    assert.equal(sqlite.items[0].anchor, 'ADR-001');
    // kind filter
    const decisionsOnly = ws.store.search({ query: 'fail closed', kinds: ['lesson'] });
    assert.equal(decisionsOnly.items.length, 0);
    const lessonHit = ws.store.search({ query: 'fts5 triggers', kinds: ['lesson'] });
    assert.equal(lessonHit.items[0].anchor, 'lessons-lesson-fts5-triggers');
    // CJK trigram (>=3 chars)
    const zh = ws.store.search({ query: '证据库' });
    assert.ok(zh.items.length >= 1, 'trigram must match 3-char CJK');
    // CJK 2-char → LIKE fallback
    const zhShort = ws.store.search({ query: '周会' });
    assert.ok(zhShort.items.length >= 1, '2-char CJK must hit the LIKE fallback');
    assert.equal(zhShort.matchMode, 'like-fallback');
    // demotion: supersede ADR-002, then active rows come first
    ws.store.supersede('ADR-002', 'ADR-001');
    const mixed = ws.store.search({ query: 'fail closed revision' });
    const superseded = mixed.items.find((i) => i.anchor === 'ADR-002');
    if (superseded) {
      assert.ok(mixed.items.indexOf(superseded) >= 0);
      assert.equal(superseded.supersededBy, 'ADR-001');
      const activeBefore = mixed.items.filter((i) => !i.supersededBy).length;
      assert.ok(
        mixed.items.slice(0, activeBefore).every((i) => !i.supersededBy),
        'superseded rows must be demoted to the tail',
      );
    }
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('drill: revision-verified reads fail closed on every drift mode', async () => {
  const ws = await tempWorkspace();
  try {
    await indexRoot(ws.store, ws.fixtures);
    const adr1 = ws.store.getByAnchor('ADR-001');

    // ok path — and a successful verified read records a drill episode
    const ok = await ws.store.drill({ anchor: 'ADR-001', expectedRevision: adr1.revision });
    assert.equal(ok.status, 'ok');
    assert.match(ok.content, /node:sqlite/);
    assert.equal(ok.truncated, false);
    assert.equal(ok.totalChars, ok.content.length);
    assert.equal(
      ws.store.hasConsumedRevision({
        owner: 'default',
        family: 'drill',
        sourceAnchor: 'ADR-001',
        sourceRevision: adr1.revision,
      }),
      true,
      'successful drill must record a drill-family consumption row',
    );

    // context bound: oversized sources are truncated with an explicit flag
    const small = await ws.store.drill({ anchor: 'ADR-001', maxChars: 50 });
    assert.equal(small.status, 'ok');
    assert.equal(small.truncated, true);
    assert.equal(small.content.length, 50);
    assert.ok(small.totalChars > 50, 'totalChars reports the real length');

    // stale expectedRevision
    const stale = await ws.store.drill({ anchor: 'ADR-001', expectedRevision: 'deadbeef' });
    assert.equal(stale.status, 'not_available');
    assert.equal(stale.invalidationReason, 'stale_revision');

    // git-style hex prefix (>=8 chars) is accepted, case-insensitively
    const prefix = adr1.revision.slice(0, 8);
    const byPrefix = await ws.store.drill({ anchor: 'ADR-001', expectedRevision: prefix });
    assert.equal(byPrefix.status, 'ok');
    const byLongPrefix = await ws.store.drill({
      anchor: 'ADR-001',
      expectedRevision: adr1.revision.slice(0, 32).toUpperCase(),
    });
    assert.equal(byLongPrefix.status, 'ok');
    // non-hex or ambiguous-short prefixes still fail closed
    const shortPrefix = await ws.store.drill({ anchor: 'ADR-001', expectedRevision: 'ab12' });
    assert.equal(shortPrefix.invalidationReason, 'stale_revision');
    const wrongHex = await ws.store.drill({ anchor: 'ADR-001', expectedRevision: '00000000' });
    assert.equal(wrongHex.invalidationReason, 'stale_revision');

    // source modified after indexing
    const file = adr1.sourcePath;
    const original = await readFile(file, 'utf8');
    await writeFile(file, original + '\n<!-- late edit -->\n', 'utf8');
    const modified = await ws.store.drill({ anchor: 'ADR-001', expectedRevision: adr1.revision });
    assert.equal(modified.status, 'not_available');
    assert.equal(modified.invalidationReason, 'source_modified');
    await writeFile(file, original, 'utf8');

    // source missing
    await rm(file);
    const missing = await ws.store.drill({ anchor: 'ADR-001' });
    assert.equal(missing.status, 'not_available');
    assert.equal(missing.invalidationReason, 'source_missing');

    // unknown anchor
    const notFound = await ws.store.drill({ anchor: 'ADR-404' });
    assert.equal(notFound.invalidationReason, 'not_found');

    // inactive (superseded) source
    ws.store.supersede('ADR-002', 'ADR-001');
    const inactive = await ws.store.drill({ anchor: 'ADR-002' });
    assert.equal(inactive.status, 'not_available');
    assert.equal(inactive.invalidationReason, 'inactive');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('cue ledger: one terminal consumption per revision, revision-scoped', async () => {
  const store = new EvidenceStore(':memory:');
  try {
    const args = { owner: 'user-1', family: 'decision', sourceAnchor: 'ADR-001', sourceRevision: 'r1' };
    assert.equal(store.hasConsumedRevision(args), false);
    const first = store.recordCueConsumption({ ...args, terminal: 'drilled' });
    assert.equal(first.newlyRecorded, true);
    const second = store.recordCueConsumption({ ...args, terminal: 'drilled' });
    assert.equal(second.newlyRecorded, false, 'duplicate consumption must be idempotent');
    assert.equal(store.hasConsumedRevision(args), true);
    // different revision → not consumed
    assert.equal(
      store.hasConsumedRevision({ ...args, sourceRevision: 'r2' }),
      false,
      'consumption is scoped to the exact revision',
    );
  } finally {
    store.close();
  }
});

test('rebuild: wipe + rescan remembered roots restores parity, ledger preserved', async () => {
  const ws = await tempWorkspace();
  try {
    await indexRoot(ws.store, ws.fixtures);
    const before = ws.store.stats();
    ws.store.recordCueConsumption({
      owner: 'u',
      family: 'decision',
      sourceAnchor: 'ADR-001',
      sourceRevision: ws.store.getByAnchor('ADR-001').revision,
    });
    // drift the index by hand, then rebuild
    ws.store.db.prepare("UPDATE evidence_docs SET title = 'corrupted' WHERE anchor = 'ADR-001'").run();
    const rebuilt = await rebuildAll(ws.store);
    assert.equal(rebuilt.scanned, 5);
    const after = ws.store.stats();
    assert.equal(after.total, before.total);
    assert.equal(after.byKind.decision, before.byKind.decision);
    assert.equal(after.byKind.lesson, before.byKind.lesson);
    assert.equal(ws.store.getByAnchor('ADR-001').title, 'Choose node:sqlite as the evidence store driver');
    assert.equal(after.cueEpisodes, 1, 'cue ledger must survive rebuild');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('idempotent reindex keeps updated_at stable when content is unchanged', async () => {
  const ws = await tempWorkspace();
  try {
    await indexRoot(ws.store, ws.fixtures);
    const first = ws.store.getByAnchor('ADR-002');
    await new Promise((r) => setTimeout(r, 15));
    const secondRun = await indexRoot(ws.store, ws.fixtures);
    assert.equal(secondRun.updated, 0);
    assert.equal(secondRun.unchanged, 5);
    const second = ws.store.getByAnchor('ADR-002');
    assert.equal(second.updatedAt, first.updatedAt, 'updated_at must not churn on no-op reindex');
    assert.equal(second.revision, first.revision);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('recency decay ranks fresh evidence above stale on equal lexical match', async () => {
  const ws = await tempWorkspace();
  try {
    await indexRoot(ws.store, ws.fixtures);
    // Two lessons with near-identical lexical content: backdate one by 400 days.
    const dir = join(ws.fixtures, 'lessons');
    await writeFile(
      join(dir, 'lesson-fresh-topic.md'),
      '---\ntitle: "Zeta topic canonical answer"\nkind: lesson\nkeywords: "zeta, unique, topic"\nsummary: "zeta unique topic fresh answer"\n---\n\nFresh zeta unique topic lesson.\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'lesson-stale-topic.md'),
      '---\ntitle: "Zeta topic canonical answer old"\nkind: lesson\nkeywords: "zeta, unique, topic"\nsummary: "zeta unique topic stale answer"\n---\n\nStale zeta unique topic lesson.\n',
      'utf8',
    );
    await indexRoot(ws.store, ws.fixtures);
    const staleAnchor = 'lessons-lesson-stale-topic';
    ws.store.db
      .prepare('UPDATE evidence_docs SET updated_at = ? WHERE anchor = ?')
      .run(new Date(Date.now() - 400 * 86_400_000).toISOString(), staleAnchor);
    const { items } = ws.store.search({ query: 'zeta unique topic', limit: 2 });
    assert.equal(items.length, 2);
    assert.equal(items[0].anchor, 'lessons-lesson-fresh-topic', 'fresh lesson must outrank the 400-day-old one');
    // decay can be turned off
    const plain = ws.store.search({ query: 'zeta unique topic', limit: 2, recencyDecay: false });
    assert.equal(plain.items.length, 2, 'lexical-only ranking still returns both');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('deleting a source file removes its index rows on rescan (no orphan leakage)', async () => {
  const ws = await tempWorkspace();
  try {
    await indexRoot(ws.store, ws.fixtures);
    assert.ok(ws.store.getByAnchor('ADR-002'));
    // delete the source file and rescan the same root
    await rm(join(ws.fixtures, 'decisions', 'ADR-002-fail-closed-drill.md'));
    const second = await indexRoot(ws.store, ws.fixtures);
    assert.ok(second.removed.includes('ADR-002'), 'orphan row must be dropped');
    assert.equal(ws.store.getByAnchor('ADR-002'), null);
    // search no longer surfaces its title or summary
    const hits = ws.store.search({ query: 'fail closed revision mismatch', limit: 20 });
    assert.ok(hits.items.every((i) => i.anchor !== 'ADR-002'), 'deleted memory must not appear in search');
    // drill fails closed with not_found
    const drill = await ws.store.drill({ anchor: 'ADR-002' });
    assert.equal(drill.status, 'not_available');
    assert.equal(drill.invalidationReason, 'not_found');
    // other roots' rows are untouched (ADR-001 from the same root stays)
    assert.ok(ws.store.getByAnchor('ADR-001'));
    assert.equal(second.scanned, 4);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('empty knowledge root is handled without error', async () => {
  const ws = await tempWorkspace();
  try {
    const emptyRoot = join(ws.dir, 'empty');
    await mkdir(emptyRoot, { recursive: true });
    const result = await indexRoot(ws.store, emptyRoot);
    assert.equal(result.scanned, 0);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});
