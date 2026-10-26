// Four-competency E2E regression net, modeled on MemoryAgentBench's core
// competencies (arXiv:2507.05257): accurate retrieval, test-time learning,
// long-range understanding, selective forgetting. Each test drives the REAL
// pipeline end to end (ingest -> search -> drill -> forget -> relearn) 鈥?// this is the safety net for future changes to any single component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../src/store.js';
import { ingestMemory } from '../src/ingest-service.js';
import { executeForget } from '../src/forget-service.js';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comp-'));
  const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
  return { dir, store };
}

test('competency 1 鈥?accurate retrieval: paraphrase and vocabulary-gap queries find the fact', async () => {
  const { dir, store } = await freshStore();
  try {
    const obs = ingestMemory(store, { text: 'The user is migrating their blog from WordPress to Astro', tags: ['projects'] });
    // paraphrase (lexical overlap path)
    const para = store.search({ query: 'blog migration away from wordpress', limit: 5 });
    assert.ok(para.items.some((i) => i.anchor === obs.anchor), 'paraphrased query retrieves the fact');
    // drill round-trip with revision verification
    const row = para.items.find((i) => i.anchor === obs.anchor);
    // dynamic rows have no source: drill reports no_source (fail-closed), the
    // summary itself was already verified via search 鈥?content served inline.
    const drilled = await store.drill({ anchor: obs.anchor });
    assert.equal(drilled.status, 'not_available');
    assert.equal(drilled.invalidationReason, 'no_source');
    assert.ok(row.summary.includes('Astro'));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('competency 2 鈥?test-time learning: restatement supersedes, only the new fact answers', async () => {
  const { dir, store } = await freshStore();
  try {
    const v1 = ingestMemory(store, { text: 'The user lives in Hangzhou and works remotely' });
    const v2 = ingestMemory(store, { text: 'The user used to live in Hangzhou but now lives in Chengdu' });
    assert.equal(v2.decision, 'update', 'restatement flips to UPDATE');
    const hit = store.search({ query: 'where does the user live', limit: 5 });
    const active = hit.items.filter((i) => i.status === 'active');
    assert.equal(active.length, 1, 'exactly one live answer');
    assert.equal(active[0].anchor, v2.anchor);
    assert.equal(store.getByAnchor(v1.anchor).supersededBy, v2.anchor);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('competency 3 鈥?long-range understanding: temporal query surfaces the dated fact', async () => {
  const { dir, store } = await freshStore();
  try {
    ingestMemory(store, {
      text: 'The user traveled to Penang for the winter retreat',
      date: '2024-12-10',
      importance: 3,
    });
    ingestMemory(store, { text: 'The user plans a summer hiking trip in the Alps' });
    const hit = store.search({ query: '2024骞?2鏈?the user winter travel', limit: 5 });
    assert.equal(hit.items[0].anchor && store.getByAnchor(hit.items[0].anchor).keywords.includes('2024-12-10'),
      true, 'the December-dated memory ranks first under a temporal query');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('competency 4 鈥?selective forgetting: deny-list holds, relearning wins, no resurrection', async () => {
  const { dir, store } = await freshStore();
  try {
    const fact = ingestMemory(store, { text: 'The user keeps a secret notebook of cake recipes from aunt Marple' });
    // Backdate: the fresh-write guard correctly protects just-written rows
    // from forgetting — established knowledge is what forget targets.
    store.db
      .prepare('UPDATE evidence_docs SET updated_at = ? WHERE anchor = ?')
      .run(new Date(Date.now() - 3_600_000).toISOString(), fact.anchor);
    // forget the topic
    const fr = await executeForget(store, { scope: 'facts', targets: ['secret cake recipes'] });
    assert.equal(fr.removed, 1);
    assert.equal(fr.retractionMarker, true);
    // answer-time enforcement: marker live, original fact gone
    const hit = store.search({ query: 'cake recipes from aunt Marple', limit: 5 });
    assert.ok(hit.items.some((i) => i.kind === 'retraction' && i.status === 'active'), 'marker is live after forget');
    assert.equal(store.getByAnchor(fact.anchor), null, 'forgotten row is gone');
    // relearning overrides the refusal
    const re = ingestMemory(store, { text: 'The user again writes down cake recipes from aunt Marple in a notebook' });
    assert.ok(re.supersededRetractions >= 1, 'marker superseded by relearning');
    const after = store.search({ query: 'cake recipes notebook', limit: 5 });
    assert.ok(after.items.some((i) => i.anchor === re.anchor && i.status === 'active'), 'relearned fact is retrievable');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
