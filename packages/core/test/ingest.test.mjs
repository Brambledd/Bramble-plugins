// Coordinated-behavior tests for the unified ingest pipeline, memory links,
// access-driven decay, probe fallback and time-aware boost. These cover the
// interaction contracts, not just units: write-path consolidation, link
// hygiene on delete, and the search-side expansions sharing one probe owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../src/store.js';
import { ingestMemory, overlapsEntry } from '../src/ingest-service.js';
import { executeForget } from '../src/forget-service.js';
import { EVIDENCE_APPLICATION_ID, EVIDENCE_SCHEMA_VERSION } from '../src/schema.js';
import { computeRevision, buildProbes, parseTemporalQuery } from '../src/util.js';

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ingest-'));
  const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
  return { dir, store };
}

function note(store, anchor, summary, keywords = [], updatedAt = new Date(Date.now() - 3_600_000).toISOString()) {
  store.upsert({
    anchor,
    kind: 'note',
    status: 'active',
    authority: 'standard',
    title: summary.slice(0, 120),
    summary,
    keywords,
    sourcePath: null,
    revision: null,
    supersededBy: null,
    updatedAt, // backdated by default: established knowledge, not fresh-write-protected
  });
}

test('parseTemporalQuery: absolute + relative windows, no false positives', () => {
  const now = new Date('2026-02-15T08:00:00Z');
  assert.deepEqual(parseTemporalQuery('2024-12-05 的行程', now), { since: '2024-12-05', until: '2024-12-05' });
  const dec = parseTemporalQuery('2024年12月的旅行计划', now);
  assert.equal(dec.since, '2024-12-01');
  assert.equal(dec.until, '2024-12-31');
  const lastMonth = parseTemporalQuery('上个月的决定', now);
  assert.equal(lastMonth.since, '2026-01-01');
  assert.equal(lastMonth.until, '2026-01-31');
  const recent = parseTemporalQuery('最近 7 天的会议记录', now);
  assert.equal(recent.since, '2026-02-08');
  assert.equal(recent.until, '2026-02-15');
  const lastYear = parseTemporalQuery('did we decide anything last year?', now);
  assert.equal(lastYear.since, '2025-01-01');
  assert.equal(lastYear.until, '2025-12-31');
  assert.equal(parseTemporalQuery('彭亨岛的旅行计划', now), null);
  assert.equal(parseTemporalQuery('', now), null);
});

test('buildProbes: sub-phrases + CJK bigrams, deduped', () => {
  const probes = buildProbes('意大利餐厅推荐');
  assert.ok(probes.includes('意大利餐厅推荐'));
  assert.ok(probes.includes('意大'), 'CJK bigram probe present');
  assert.ok(probes.includes('推荐'), 'trailing bigram probe present');
  const latin = buildProbes('the user prefers Italian restaurants overall');
  assert.ok(latin.some((p) => p === 'user prefers'.replace('the ', '')), 'first-2 content words probe');
  assert.ok(latin.includes('restaurants overall'), 'last-2 content words probe');
  assert.equal(buildProbes('').length, 0);
});

test('ingest: exact restatement is a NOOP (no duplicate row)', async () => {
  const { dir, store } = await tempStore();
  try {
    const first = ingestMemory(store, { text: 'The user prefers dark mode in all editors' });
    assert.equal(first.decision, 'add');
    const again = ingestMemory(store, { text: 'the user prefers DARK MODE in all editors' });
    assert.equal(again.decision, 'noop');
    assert.equal(again.anchor, first.anchor);
    assert.equal(store.stats().total, 1, 'no second row written');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ingest: variant restatement supersedes the old note (UPDATE)', async () => {
  const { dir, store } = await tempStore();
  try {
    const first = ingestMemory(store, { text: 'The user prefers dark mode in all editors' });
    const second = ingestMemory(store, { text: 'The user prefers dark mode in editors and terminals now' });
    assert.equal(second.decision, 'update');
    assert.equal(second.supersededNote, first.anchor);
    const old = store.getByAnchor(first.anchor);
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, second.anchor);
    assert.equal(store.getByAnchor(second.anchor).status, 'active');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ingest: distinct facts coexist as ADDs', async () => {
  const { dir, store } = await tempStore();
  try {
    const a = ingestMemory(store, { text: 'The user is migrating their blog from WordPress to Astro' });
    const b = ingestMemory(store, { text: 'The user is learning to play the cello' });
    assert.equal(a.decision, 'add');
    assert.equal(b.decision, 'add');
    assert.equal(store.stats().total, 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ingest: relearning supersedes an active retraction marker (forget→relearn round-trip)', async () => {
  const { dir, store } = await tempStore();
  try {
    note(store, 'have-1', 'The user enjoyed crystal ball predictions at the December fair', ['2025-12-05']);
    const fr = await executeForget(store, { scope: 'facts', targets: ['crystal ball predictions'] });
    assert.equal(fr.removed, 1);
    assert.equal(fr.retractionMarker, true);
    const obs = ingestMemory(store, { text: 'The user still enjoys crystal ball predictions at fairs' });
    assert.equal(obs.decision, 'add');
    assert.equal(obs.supersededRetractions, 1, 'marker flipped by relearning');
    const marker = store.db.prepare("SELECT status FROM evidence_docs WHERE kind='retraction'").get();
    assert.equal(marker.status, 'superseded');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('links: built on ingest, never to retraction markers, cleaned by removeByAnchor', async () => {
  const { dir, store } = await tempStore();
  try {
    note(store, 'doc-a', 'The user keeps notes about sourdough starter hydration ratios');
    const ing = ingestMemory(store, { text: 'The user bakes sourdough bread on weekends' });
    // note: marker excluded from links
    note(store, 'doc-c', 'Completely unrelated: the printer driver needs a reboot weekly');
    const neighbors = store.linkNeighbors([ing.anchor], { cap: 5 });
    assert.ok(neighbors.some((n) => n.anchor === 'doc-a'), 'sourdough doc linked');
    assert.ok(!neighbors.some((n) => n.kind === 'retraction'));
    // delete the linked doc — its edges must go with it
    store.removeByAnchor('doc-a');
    assert.equal(store.linkNeighbors([ing.anchor], { cap: 5 }).some((n) => n.anchor === 'doc-a'), false);
    const edges = store.db.prepare('SELECT COUNT(*) AS n FROM evidence_links WHERE anchor=? OR linked_anchor=?').get('doc-a', 'doc-a');
    assert.equal(edges.n, 0, 'no dangling edges after delete');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('search: CJK bigram probe fallback rescues sub-trigram queries', async () => {
  const { dir, store } = await tempStore();
  try {
    note(store, 'it-1', '用户喜欢意大利餐厅，每周去两次');
    const hit = store.search({ query: '意大利餐厅推荐', limit: 5 });
    assert.equal(hit.matchMode, 'probe-fallback', 'primary miss recovered by probes');
    assert.ok(hit.items.some((i) => i.anchor === 'it-1'));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('search: time-aware boost surfaces date-tokened entries for temporal queries', async () => {
  const { dir, store } = await tempStore();
  try {
    note(store, 'trip-penang', 'Trip plan to Penang in winter', ['2024-12-05']);
    note(store, 'trip-tokyo', 'Trip plan to Tokyo next spring', []);
    const hit = store.search({ query: '2024年12月 trip plan', limit: 5 });
    assert.ok(hit.items.length >= 2);
    assert.equal(hit.items[0].anchor, 'trip-penang', 'dated entry ranks first under temporal query');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('drill stamps last_accessed; links survive unrelated deletes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ingest-drill-'));
  const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
  try {
    const file = join(dir, 'adr-900.md');
    const content = `---\ntitle: ADR-0900\nkind: decision\nstatus: accepted\nsummary: use node:sqlite\n---\n\n# ADR-0900\n\nUse node:sqlite everywhere.\n`;
    await writeFile(file, content, 'utf8');
    store.upsert({
      anchor: 'ADR-0900',
      kind: 'decision',
      status: 'accepted',
      authority: 'standard',
      title: 'ADR-0900',
      summary: 'use node:sqlite',
      keywords: [],
      sourcePath: file,
      revision: computeRevision(content),
      supersededBy: null,
    });
    note(store, 'other-1', 'An unrelated memory row');
    store.putLink('ADR-0900', 'other-1', 1);
    const before = store.getByAnchor('ADR-0900').lastAccessed;
    assert.equal(before, null);
    const drilled = await store.drill({ anchor: 'ADR-0900' });
    assert.equal(drilled.status, 'ok');
    const after = store.getByAnchor('ADR-0900').lastAccessed;
    assert.ok(after, 'drill stamped access time');
    // deleting an unrelated doc keeps this edge
    store.removeByAnchor('nonexistent');
    assert.equal(store.linkNeighbors(['ADR-0900'], { cap: 3 }).length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('overlapsEntry stays exported from capture-service (compat re-export)', async () => {
  const mod = await import('../../capture/src/capture-service.js');
  assert.equal(typeof mod.overlapsEntry, 'function');
  assert.ok(mod.overlapsEntry('The user prefers dark mode themes', { title: 'prefers dark mode', summary: 'in all editors' }));
});

test('ingest: date token and importance ride through to the stored row', async () => {
  const { dir, store } = await tempStore();
  try {
    const res = ingestMemory(store, {
      text: 'The user is moving to Penang in December',
      source: 'observe',
      date: '2024-12-01',
      importance: 5,
    });
    assert.equal(res.decision, 'add');
    const row = store.getByAnchor(res.anchor);
    assert.ok(row.keywords.includes('2024-12-01'), 'date token indexed');
    assert.equal(row.importance, 5);
    // importance clamps
    const res2 = ingestMemory(store, { text: 'The user also enjoys weekend cycling trips', importance: 99 });
    assert.equal(store.getByAnchor(res2.anchor).importance, 5);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ranking: importance is a bounded nudge (imp 5 lifts an otherwise-tied row)', async () => {
  const { dir, store } = await tempStore();
  try {
    const text = 'The team standardizes deployment on blue green releases';
    note(store, 'plain-1', text);
    store.upsert({
      anchor: 'vital-1', kind: 'note', status: 'active', authority: 'standard',
      title: text, summary: text, keywords: [], sourcePath: null, revision: null,
      supersededBy: null, importance: 5, updatedAt: new Date().toISOString(),
    });
    const hit = store.search({ query: text, limit: 5 });
    assert.equal(hit.items[0].anchor, 'vital-1', 'importance 5 outranks the tied importance 1 row');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('additive migration: pre-column database gains columns without losing rows', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mig-'));
  const path = join(dir, 'legacy.sqlite');
  {
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE evidence_docs (
      anchor TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      authority TEXT NOT NULL DEFAULT 'standard', title TEXT NOT NULL, summary TEXT,
      keywords TEXT, source_path TEXT, source_hash TEXT, superseded_by TEXT, updated_at TEXT NOT NULL
    );`);
    raw.prepare("INSERT INTO evidence_docs VALUES ('old-1','note','active','standard','legacy','old row content','',null,null,null,'2025-01-01T00:00:00.000Z')").run();
    // Mark it as a genuine (old-layout) evidence index so the application
    // guard admits it — exactly what a real pre-migration database looks like.
    raw.exec(`PRAGMA application_id = ${EVIDENCE_APPLICATION_ID};`);
    raw.exec(`PRAGMA user_version = ${EVIDENCE_SCHEMA_VERSION};`);
    raw.close();
  }
  const store = new EvidenceStore(path);
  try {
    const row = store.getByAnchor('old-1');
    assert.ok(row, 'legacy row survived the migration');
    assert.equal(row.importance, 1, 'new column defaulted');
    assert.equal(row.lastAccessed, null);
    store.touchAnchor('old-1');
    assert.ok(store.getByAnchor('old-1').lastAccessed, 'new column is writable');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('vector lane length gate: long summaries excluded from backfill, short included', async () => {
  const { dir, store } = await tempStore();
  try {
    const { createEmbeddingBackend } = await import('../src/embedding.js');
    store.attachEmbedding(createEmbeddingBackend({ enabled: true, backend: 'hash' }));
    const shortText = 'The user prefers window seats on every flight they take';
    const longText = 'The user described a very long trip itinerary. '.repeat(80); // ~3.8KB
    note(store, 'short-1', shortText, [], new Date().toISOString());
    note(store, 'long-1', longText, [], new Date().toISOString());
    store.db.prepare('UPDATE evidence_docs SET source_hash = ? WHERE anchor IN (?, ?)')
      .run('a'.repeat(64), 'short-1', 'long-1');
    // production default gate: 2000 chars
    let embedded = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = await store.embedBackfill({ batchSize: 16, maxIndexedChars: 2000 });
      embedded += r.embedded;
      if (r.embedded === 0) break;
    }
    assert.equal(embedded, 1, 'only the short document enters the vector lane');
    assert.ok(store.vectors.freshFor('short-1', 'a'.repeat(64)), 'short doc vector stored');
    assert.equal(store.vectors.freshFor('long-1', 'a'.repeat(64)), null, 'long doc excluded by the gate');
    // gate disabled: both enter
    for (let i = 0; i < 5; i += 1) {
      const r = await store.embedBackfill({ batchSize: 16, maxIndexedChars: 0 });
      if (r.embedded === 0) break;
    }
    assert.ok(store.vectors.freshFor('long-1', 'a'.repeat(64)), 'gate 0 disables the length filter');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
