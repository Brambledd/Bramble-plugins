// Auto-capture service tests: extraction parsing, dedup, budget meter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../../core/src/store.js';
import {
  captureSystemPrompt,
  captureUserPrompt,
  isDuplicate,
  overlapsEntry,
  parseFactObjects,
  parseFacts,
  runCapturePass,
  todayCapturedCount,
} from '../src/capture-service.js';

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-capture-'));
  const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
  return { dir, store };
}

test('parseFacts: strict JSON, tolerant JSON-in-text, caps and length filters', () => {
  const strict = '{"facts":["The user prefers dark mode","The user lives in Hangzhou"]}';
  assert.deepEqual(parseFacts(strict, 6).length, 2);
  const noisy = 'Sure! Here you go:\n```json\n{"facts":["The user uses pnpm as their package manager"]}\n```';
  assert.equal(parseFacts(noisy, 6).length, 1);
  assert.deepEqual(parseFacts('no json at all', 6), []);
  // dedup within batch + length bounds
  const dup = '{"facts":["The user likes tea","the user   likes tea","ok","' + 'x'.repeat(300) + '"]}';
  const parsed = parseFacts(dup, 6);
  assert.equal(parsed.length, 1);
  // maxFacts cap
  const many = '{"facts":["a1b2c3d4e5","f6g7h8i9j0","k1l2m3n4o5","p6q7r8s9t0"]}';
  assert.equal(parseFacts(many, 2).length, 2);
});

test('overlapsEntry + isDuplicate: near-duplicate detection', async () => {
  const { dir, store } = await tempStore();
  try {
    store.upsert({
      anchor: 'have-1', kind: 'note', status: 'active', authority: 'standard',
      title: 'User prefers dark mode', summary: 'The user prefers dark mode in all editors and terminals',
      keywords: [], sourcePath: null, revision: null, supersededBy: null,
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    assert.ok(overlapsEntry('The user prefers dark mode themes', store.getByAnchor('have-1')));
    assert.ok(isDuplicate(store, 'The user prefers dark mode themes'));
    assert.equal(isDuplicate(store, 'The user is learning to play the cello'), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCapturePass: writes new facts, skips duplicates, redacts secrets', async () => {
  const { dir, store } = await tempStore();
  try {
    store.upsert({
      anchor: 'have-1', kind: 'note', status: 'active', authority: 'standard',
      title: 'User prefers dark mode', summary: 'The user prefers dark mode in all editors',
      keywords: [], sourcePath: null, revision: null, supersededBy: null,
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const answer = JSON.stringify({
      facts: [
        'The user prefers dark mode in all editors',
        'The user is migrating their blog from WordPress to Astro',
        'Their deploy token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
      ],
    });
    const result = await runCapturePass(
      store,
      async () => answer,
      { turnTexts: ['t1', 't2'], maxFacts: 6, redact: true },
    );
    assert.equal(result.written, 2, 'duplicate skipped, two new facts written');
    assert.equal(result.skipped, 1);
    assert.ok(result.redactions >= 1, 'token was redacted');
    const stored = [...result.facts];
    assert.ok(stored.some((f) => f.includes('[api-key]')), 'redaction tag present');
    // daily meter counts the cap-* writes
    assert.ok(todayCapturedCount(store) >= 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('prompts: known entries + numbered turns', () => {
  const sys = captureSystemPrompt(6);
  assert.match(sys, /STRICT JSON/);
  assert.match(sys, /at most 6 facts/);
  const user = captureUserPrompt(['Known fact one'], ['turn text A', 'turn text B']);
  assert.match(user, /Known memory entries/);
  assert.match(user, /【turn 1】turn text A/);
});

test('parseFactObjects: structured facts with date + importance, string compat, clamps', () => {
  const structured = JSON.stringify({
    facts: [
      { text: 'The user is moving to Penang this December', date: '2024-12-01', importance: 5 },
      { text: 'The user likes cycling on weekends', importance: 99 },
      { text: 'The user likes cycling on weekends' },
      'plain string fact ok here',
      { text: 'x' },
    ],
  });
  const parsed = parseFactObjects(structured, 6);
  assert.equal(parsed.length, 3, 'duplicate cycling fact and sub-length "x" dropped');
  assert.deepEqual([parsed[0].date, parsed[0].importance], ['2024-12-01', 5]);
  assert.equal(parsed[1].importance, 5, 'importance clamps to 5');
  assert.equal(parsed[2].importance, 1);
  assert.deepEqual([parsed[2].text, parsed[2].date, parsed[2].importance], ['plain string fact ok here', null, 1]);
  assert.equal(parseFactObjects('{"facts": ["short"]}', 6).length, 0, 'length filter applies to structured path');
  assert.deepEqual(parseFacts(structured, 6)[0], 'The user is moving to Penang this December');
});

test('runCapturePass: date and importance land in the stored row via ingest', async () => {
  const { dir, store } = await tempStore();
  try {
    const answer = JSON.stringify({
      facts: [{ text: 'The user is moving to Penang this December', date: '2024-12-01', importance: 5 }],
    });
    const result = await runCapturePass(store, async () => answer, { turnTexts: ['t'], maxFacts: 4, redact: false });
    assert.equal(result.written, 1);
    const anchors = store.db.prepare("SELECT anchor FROM evidence_docs WHERE anchor LIKE 'cap-%'").all();
    assert.equal(anchors.length, 1);
    const row = store.getByAnchor(anchors[0].anchor);
    assert.ok(row.keywords.includes('2024-12-01'), 'date token indexed by ingest');
    assert.equal(row.importance, 5, 'importance stored through ingest');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
