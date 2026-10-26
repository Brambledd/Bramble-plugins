// Condensation (sixth atomic op) tests: mutual-overlap merge precision,
// archive hygiene, and the coordination contracts (fresh-write skip,
// archive/forget orthogonality, bounded budgets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../src/store.js';
import { consolidateNotes } from '../src/consolidation-service.js';
import { executeForget } from '../src/forget-service.js';

function oldNote(store, anchor, summary, { daysOld = 400, importance = 1, keywords = [] } = {}) {
  const updatedAt = new Date(Date.now() - daysOld * 86_400_000).toISOString();
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
    importance,
    updatedAt,
  });
}

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-condense-'));
  const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
  return { dir, store };
}

test('merge: mutual-overlap restatements collapse onto the newer one', async () => {
  const { dir, store } = await tempStore();
  try {
    oldNote(store, 'dup-old', 'The user prefers dark mode in all editors and terminals');
    oldNote(store, 'dup-new', 'The user prefers dark mode in every editor and every terminal', { daysOld: 300 });
    const res = consolidateNotes(store, { archiveAfterDays: 0 });
    assert.equal(res.merged.length, 1, 'the near-identical pair merges once');
    assert.equal(res.merged[0].kept, 'dup-new', 'newer statement wins');
    assert.equal(res.merged[0].superseded, 'dup-old');
    assert.equal(store.getByAnchor('dup-old').status, 'superseded');
    assert.equal(store.getByAnchor('dup-new').status, 'active');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('merge precision: complementary facts are never merged', async () => {
  const { dir, store } = await tempStore();
  try {
    oldNote(store, 'dog-1', 'The user has a dog named Rex who is four years old');
    oldNote(store, 'dog-2', "The user's dog Rex loves the seaside park near their home", { daysOld: 350 });
    const res = consolidateNotes(store, { archiveAfterDays: 0 });
    assert.equal(res.merged.length, 0, 'related but complementary facts must both survive');
    assert.equal(store.getByAnchor('dog-1').status, 'active');
    assert.equal(store.getByAnchor('dog-2').status, 'active');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('archive: stale untouched trivia demoted reversibly; rated and fresh rows spared', async () => {
  const { dir, store } = await tempStore();
  try {
    oldNote(store, 'trivia-1', 'The user once mentioned liking window seats on short flights');
    oldNote(store, 'core-1', 'The user prefers window seats on every flight they take', { importance: 5 });
    oldNote(store, 'fresh-1', 'The user mentioned liking aisle seats on overnight trains', { daysOld: 1 });
    const res = consolidateNotes(store, {});
    assert.ok(res.archived.includes('trivia-1'), 'stale importance-1 trivia archived');
    assert.ok(!res.archived.includes('core-1'), 'importance 5 never archived');
    assert.ok(!res.archived.includes('fresh-1'), 'recent note never archived');
    assert.equal(store.getByAnchor('trivia-1').status, 'archived');
    // archived rows SINK in default search (demotion, not deletion 鈥?    // includeInactive:false means "rank inactive last", per the forget-service
    // contract): the active row must outrank the archived one.
    const hit = store.search({ query: 'window seats', limit: 5, includeInactive: false });
    assert.equal(hit.items[0].anchor, 'core-1', 'active row outranks the archived twin');
    assert.ok(hit.items.some((i) => i.anchor === 'trivia-1'), 'archived row still discoverable (reversible)');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('coordination: fresh-write skip and archive/forget orthogonality', async () => {
  const { dir, store } = await tempStore();
  try {
    // fresh row (minutes old) with a near-identical stale twin: the fresh row
    // is off-limits to consolidation IN BOTH DIRECTIONS 鈥?ingest owns the
    // fresh window, so the pair simply waits until the window passes.
    store.upsert({
      anchor: 'fresh-dup', kind: 'note', status: 'active', authority: 'standard',
      title: 'dark mode', summary: 'The user prefers dark mode in all editors and terminals',
      keywords: [], sourcePath: null, revision: null, supersededBy: null,
      updatedAt: new Date().toISOString(),
    });
    oldNote(store, 'stale-dup', 'The user prefers dark mode in all editors and terminals', { daysOld: 200 });
    const res = consolidateNotes(store, { archiveAfterDays: 0 });
    assert.equal(res.merged.length, 0, 'fresh row is skipped 鈥?no merge inside its window');
    assert.equal(store.getByAnchor('fresh-dup').status, 'active');
    assert.equal(store.getByAnchor('fresh-dup').supersededBy, null, 'fresh row never superseded by hygiene');
    assert.equal(store.getByAnchor('stale-dup').status, 'active', 'stale twin waits, never merges unilaterally');

    // archive and forget stay orthogonal: forgetting removes archived rows too,
    // while consolidation never deletes
    oldNote(store, 'archived-topic', 'The user collects vintage fountain pens from Osaka shops', { daysOld: 500 });
    consolidateNotes(store, {});
    assert.equal(store.getByAnchor('archived-topic').status, 'archived');
    const fr = await executeForget(store, { scope: 'facts', targets: ['vintage fountain pens Osaka'] });
    assert.equal(fr.removed, 1, 'forget still reaches archived rows');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
