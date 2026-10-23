// Targeted unlearning (forget-service) tests: full lifecycle coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../src/store.js';
import { indexRoot } from '../src/scanner.js';
import { executeForget } from '../src/forget-service.js';

// Entries inserted without sourcePath are guarded as fresh writes for 10
// minutes; tests that expect them deletable backdate the timestamp.
const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

async function tempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-forget-'));
  const fixtures = join(dir, 'knowledge');
  await cp(new URL('./fixtures', import.meta.url), fixtures, { recursive: true });
  const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
  await indexRoot(store, fixtures);
  return { dir, fixtures, store };
}

test('facts scope: single-fact deletion with residual verification', async () => {
  const ws = await tempWorkspace();
  try {
    const result = await executeForget(ws.store, {
      scope: 'facts',
      targets: ['node sqlite driver evidence store'],
    });
    assert.ok(result.removed >= 1, `should remove at least 1, got ${result.removed}`);
    assert.equal(ws.store.getByAnchor('ADR-001'), null, 'ADR-001 should be removed');
    assert.ok(ws.store.getByAnchor('ADR-002'), 'ADR-002 should survive');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('topic scope: category deletion removes multiple entries', async () => {
  const ws = await tempWorkspace();
  try {
    ws.store.upsert({ anchor: 'health-1', kind: 'note', status: 'active', authority: 'standard',
      title: 'blood pressure medication', summary: 'takes lisinopril daily for blood pressure',
      keywords: ['health','blood','pressure','medication'],
      sourcePath: null, revision: 'r1', supersededBy: null, updatedAt: STALE });
    ws.store.upsert({ anchor: 'health-2', kind: 'note', status: 'active', authority: 'standard',
      title: 'iron deficiency diagnosis', summary: 'iron deficiency anemia health condition diagnosed',
      keywords: ['health','iron','anemia','diagnosis'],
      sourcePath: null, revision: 'r2', supersededBy: null, updatedAt: STALE });
    const result = await executeForget(ws.store, {
      scope: 'topic',
      targets: ['health medical medication blood pressure anemia'],
    });
    assert.ok(result.removed >= 1, `should remove health entries, got ${result.removed}`);
    assert.ok(ws.store.getByAnchor('ADR-001'), 'ADR-001 should survive');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('timerange scope: deterministic date filtering', async () => {
  const ws = await tempWorkspace();
  try {
    ws.store.upsert({ anchor: 'dec-event', kind: 'note', status: 'active', authority: 'standard',
      title: 'December party', summary: 'holiday gathering party',
      keywords: ['party','2025-12-15'],
      sourcePath: null, revision: 'r1', supersededBy: null, updatedAt: STALE });
    ws.store.upsert({ anchor: 'jan-event', kind: 'note', status: 'active', authority: 'standard',
      title: 'January meeting', summary: 'kickoff meeting',
      keywords: ['meeting','2026-01-10'],
      sourcePath: null, revision: 'r2', supersededBy: null, updatedAt: STALE });
    const result = await executeForget(ws.store, {
      scope: 'timerange',
      since: '2025-12-01',
      until: '2025-12-31',
    });
    assert.ok(result.removed >= 1, `should remove December entry, got ${result.removed}`);
    assert.equal(ws.store.getByAnchor('dec-event'), null, 'dec-event should be removed');
    assert.ok(ws.store.getByAnchor('jan-event'), 'January entry should survive');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('F6 replacement: old deleted, new written', async () => {
  const ws = await tempWorkspace();
  try {
    ws.store.upsert({ anchor: 'old-pref', kind: 'note', status: 'active', authority: 'standard',
      title: 'likes Thai food', summary: 'favorite cuisine is Thai food',
      keywords: ['food','thai','cuisine','favorite'],
      sourcePath: null, revision: 'r1', supersededBy: null, updatedAt: STALE });
    const result = await executeForget(ws.store, {
      scope: 'facts',
      targets: ['Thai food cuisine favorite'],
      replacement: 'Now prefers Italian restaurants',
    });
    assert.ok(result.removed >= 1, 'old value should be removed');
    assert.ok(result.replacementWritten, 'replacement should be written');
    assert.ok(result.replacementAnchor, 'replacement anchor should be returned');
    const newEntry = ws.store.getByAnchor(result.replacementAnchor);
    assert.ok(newEntry, 'replacement entry should exist in store');
    assert.match(newEntry.summary, /Italian/);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('soft delete: file-sourced entry gets frontmatter status:deleted', async () => {
  const ws = await tempWorkspace();
  try {
    const adr1 = ws.store.getByAnchor('ADR-001');
    assert.ok(adr1.sourcePath, 'ADR-001 should have a sourcePath');
    const result = await executeForget(ws.store, {
      scope: 'facts',
      targets: ['node sqlite driver evidence store'],
    });
    assert.ok(result.removed >= 1);
    // index entry gone
    assert.equal(ws.store.getByAnchor('ADR-001'), null);
    // file still exists but has status: deleted
    assert.ok(existsSync(adr1.sourcePath), 'source file should still exist');
    const content = await readFile(adr1.sourcePath, 'utf8');
    assert.match(content, /status:\s*deleted/);
    // rescan should NOT bring it back
    await indexRoot(ws.store, ws.fixtures);
    assert.equal(ws.store.getByAnchor('ADR-001'), null, 'soft-deleted file should not resurface');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('fresh-write guard: recently created entries are protected', async () => {
  const ws = await tempWorkspace();
  try {
    // Write an entry with default (now) timestamp — no sourcePath
    ws.store.upsert({ anchor: 'fresh-entry', kind: 'note', status: 'active', authority: 'standard',
      title: 'just learned this', summary: 'brand new fact about testing freshness',
      keywords: ['test','fresh','new'],
      sourcePath: null, revision: 'r-fresh', supersededBy: null });
    const result = await executeForget(ws.store, {
      scope: 'facts',
      targets: ['just learned testing freshness'],
    });
    // fresh-entry should be protected (written within 10 min, no sourcePath)
    assert.ok(ws.store.getByAnchor('fresh-entry'), 'fresh entry should survive deletion');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('anti-resurrection: inference deletion records withdrawal', async () => {
  const ws = await tempWorkspace();
  try {
    ws.store.upsert({ anchor: 'infer-test', kind: 'inference', status: 'active', authority: 'standard',
      title: 'User has diversified savings strategy',
      summary: 'User has diversified savings and investment strategy',
      keywords: ['inference','savings','investment','diversified'],
      sourcePath: null, revision: 'r-inf', supersededBy: null, updatedAt: STALE });
    const result = await executeForget(ws.store, {
      scope: 'facts',
      targets: ['diversified savings investment strategy'],
    });
    assert.equal(ws.store.getByAnchor('infer-test'), null, 'inference should be deleted');
    // withdrawal should be recorded
    const withdrawn = ws.store.hasConsumedRevision({
      owner: 'system', family: 'suppressed-inference',
      sourceAnchor: 'infer-test', sourceRevision: 'r-inf',
    });
    assert.ok(withdrawn, 'withdrawal should be recorded for anti-resurrection');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

// ---------- Phase A: retraction markers (ported from clowder-ai) ----------

test('retraction marker: written on facts forget, topic words only, no fact text', async () => {
  const ws = await tempWorkspace();
  try {
    ws.store.upsert({ anchor: 'fact-x', kind: 'note', status: 'active', authority: 'standard',
      title: 'likes Thai food', summary: 'favorite cuisine is Thai food with extra basil',
      keywords: [], sourcePath: null, revision: 'r1', supersededBy: null, updatedAt: STALE });
    const result = await executeForget(ws.store, {
      scope: 'facts',
      targets: ['Thai food cuisine favorite'],
    });
    assert.ok(result.removed >= 1);
    assert.equal(result.retractionMarker, true);
    const markers = ws.store.search({ query: 'Thai food cuisine', limit: 5 }).items
      .filter((i) => i.kind === 'retraction');
    assert.equal(markers.length, 1, 'exactly one marker');
    const marker = markers[0];
    assert.equal(marker.authority, 'constitutional');
    assert.match(marker.summary, /forgottenAt/);
    assert.match(marker.summary, /UNKNOWN/);
    assert.match(marker.summary, /supersedes this marker/);
    // the marker must NOT carry the forgotten fact's own text
    assert.equal(/basil/.test(marker.summary), false, 'fact text must not leak into the marker');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('retraction marker: written even when nothing matched (removed=0)', async () => {
  const ws = await tempWorkspace();
  try {
    const result = await executeForget(ws.store, {
      scope: 'facts',
      targets: ['crystal ball future predictions'],
    });
    assert.equal(result.removed, 0);
    assert.equal(result.retractionMarker, true);
    const markers = ws.store.search({ query: 'crystal ball predictions', limit: 5 }).items
      .filter((i) => i.kind === 'retraction');
    assert.equal(markers.length, 1, 'variant-wording case needs the deny-list most');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('retraction marker: NOT written on F6 replacement; stale marker superseded', async () => {
  const ws = await tempWorkspace();
  try {
    // an older forget leaves a marker on the topic
    await executeForget(ws.store, { scope: 'facts', targets: ['Thai food cuisine favorite'] });
    const before = ws.store.search({ query: 'Thai food cuisine', limit: 5 }).items
      .filter((i) => i.kind === 'retraction' && i.status === 'active');
    assert.equal(before.length, 1);
    // now the user replaces the old preference with a new value
    ws.store.upsert({ anchor: 'old-pref', kind: 'note', status: 'active', authority: 'standard',
      title: 'likes Thai food', summary: 'favorite cuisine is Thai food',
      keywords: [], sourcePath: null, revision: 'r1', supersededBy: null, updatedAt: STALE });
    const result = await executeForget(ws.store, {
      scope: 'facts',
      targets: ['Thai food cuisine favorite'],
      replacement: 'Now prefers Italian restaurants',
    });
    assert.equal(result.retractionMarker, false, 'replacement writes no deny-list');
    assert.ok(result.replacementWritten);
    const marker = ws.store.getByAnchor(before[0].anchor);
    assert.equal(marker.status, 'superseded', 'old marker flipped to superseded');
    assert.equal(marker.supersededBy, result.replacementAnchor);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('retraction marker: same-topic re-forget refreshes instead of stacking', async () => {
  const ws = await tempWorkspace();
  try {
    await executeForget(ws.store, { scope: 'facts', targets: ['crystal ball predictions'] });
    await new Promise((r) => setTimeout(r, 20));
    await executeForget(ws.store, { scope: 'facts', targets: ['crystal ball predictions'] });
    const markers = ws.store.search({ query: 'crystal ball predictions', limit: 10 }).items
      .filter((i) => i.kind === 'retraction' && i.status === 'active');
    assert.equal(markers.length, 1, 'one live marker, refreshed');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

// ---------- Phase B: derived sweep + ack-capture ----------

test('derived sweep: paraphrased note missed by probes is swept, unrelated note kept', async () => {
  const ws = await tempWorkspace();
  try {
    const STALE_NOTE = STALE;
    // the fact being forgotten (probe words come from targets; the removed
    // summary contributes EXTRA seed words: wordpress/static/site/generator)
    ws.store.upsert({ anchor: 'fact-astro', kind: 'note', status: 'active', authority: 'standard',
      title: 'blog migration', summary: 'The user is migrating their blog from WordPress to Astro static site generator',
      keywords: [], sourcePath: null, revision: 'r1', supersededBy: null, updatedAt: STALE_NOTE });
    // a derived note restating the forgotten fact using ONLY words from the
    // removed summary that the targets never mention — invisible to probe
    // matching, catchable only by the coverage sweep
    ws.store.upsert({ anchor: 'cap-para', kind: 'note', status: 'active', authority: 'standard',
      title: 'captured: publishing stack', summary: 'Moved the publishing to a static generator setup',
      keywords: [], sourcePath: null, revision: 'r2', supersededBy: null, updatedAt: STALE_NOTE });
    // an unrelated note (zero seed overlap) must survive
    ws.store.upsert({ anchor: 'cap-other', kind: 'note', status: 'active', authority: 'standard',
      title: 'captured: pet', summary: 'The user adopted a tabby cat named Miso last spring',
      keywords: [], sourcePath: null, revision: 'r3', supersededBy: null, updatedAt: STALE_NOTE });
    const result = await executeForget(ws.store, {
      scope: 'facts',
      targets: ['migrating blog WordPress Astro'],
    });
    assert.equal(ws.store.getByAnchor('fact-astro'), null, 'the fact itself removed');
    assert.equal(ws.store.getByAnchor('cap-para'), null, 'paraphrased restatement swept');
    assert.ok(ws.store.getByAnchor('cap-other'), 'unrelated note survives');
    const sweptDetail = result.details.find((d) => d.anchor === 'cap-para');
    assert.ok(sweptDetail, 'sweep recorded in details');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('timerange ack-capture: later-written reference to the forgotten window is swept', async () => {
  const ws = await tempWorkspace();
  try {
    // the in-window fact
    ws.store.upsert({ anchor: 'dec-event', kind: 'note', status: 'active', authority: 'standard',
      title: 'Penang trip', summary: 'family holiday trip to Penang in December',
      keywords: ['penang', '2025-12-20'],
      sourcePath: null, revision: 'r1', supersededBy: null, updatedAt: STALE });
    // a LATER-written note referencing the window content (would be spared
    // by the date filter but re-leaks the topic)
    ws.store.upsert({ anchor: 'ack-ref', kind: 'note', status: 'active', authority: 'standard',
      title: 'forgetting done', summary: 'user asked to forget the Penang December trip entirely',
      keywords: [], sourcePath: null, revision: 'r2', supersededBy: null, updatedAt: STALE });
    const result = await executeForget(ws.store, {
      scope: 'timerange',
      since: '2025-12-01',
      until: '2025-12-31',
      targets: ['Penang December trip'],
    });
    assert.equal(ws.store.getByAnchor('dec-event'), null, 'window entry removed');
    assert.equal(ws.store.getByAnchor('ack-ref'), null, 'ack reference swept');
    assert.ok(
      result.details.some((d) => ['ack-capture', 'derived-sweep', 'residual'].includes(d.method)),
      'leak closed by one of the reference sweeps',
    );
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});
