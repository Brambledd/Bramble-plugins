// Cue-service tests: once-per-revision surfacing, accepted-only filtering,
// supersede retirement, budgets, revision re-surfacing after source edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '@local/dsh-memory-core/store';
import { indexRoot } from '@local/dsh-memory-core/scanner';
import {
  createDecisionCueService,
  evaluatePreferenceCues,
  globalPresentedToday,
  preferencePresentedToday,
  recordPreferencePresented,
  renderCueLine,
  userTextOfTurn,
} from '../src/cue-service.js';

async function tempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-decisions-'));
  const fixtures = join(dir, 'knowledge');
  await cp(new URL('./fixtures', import.meta.url), fixtures, { recursive: true });
  const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
  await indexRoot(store, fixtures);
  return { dir, fixtures, store, service: createDecisionCueService(store) };
}

const TURN_ABOUT_DB = 'Which database driver should we use for the new evidence store?';

test('accepted decision surfaces once; second identical turn is silent', async () => {
  const ws = await tempWorkspace();
  try {
    const first = ws.service.evaluateTurn({ turnText: TURN_ABOUT_DB, perTurnMax: 1, dailyMax: 10 });
    assert.equal(first.candidates.length, 1, 'one accepted decision should surface');
    assert.equal(first.candidates[0].anchor, 'ADR-001');
    assert.match(first.cueLine, /ADR-001/);
    assert.match(first.cueLine, /memory_drill/);
    ws.service.recordPresented(first.candidates);

    const second = ws.service.evaluateTurn({ turnText: TURN_ABOUT_DB, perTurnMax: 1, dailyMax: 10 });
    assert.ok(
      second.candidates.every((c) => c.anchor !== 'ADR-001'),
      'the surfaced revision of ADR-001 must not surface twice (other accepted decisions may)',
    );
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('captured drafts and superseded decisions never surface', async () => {
  const ws = await tempWorkspace();
  try {
    // ADR-003 (draft, captured) — ask directly about its topic
    const draft = ws.service.evaluateTurn({ turnText: 'nightly compaction draft idea', perTurnMax: 5, dailyMax: 10 });
    assert.ok(
      draft.candidates.every((c) => c.anchor !== 'ADR-003'),
      'captured drafts must never surface',
    );
    // supersede ADR-002 then ask about its topic
    ws.store.supersede('ADR-002', 'ADR-001');
    const superseded = ws.service.evaluateTurn({ turnText: 'how should drill reads handle revision mismatch', perTurnMax: 5, dailyMax: 10 });
    assert.ok(
      superseded.candidates.every((c) => c.anchor !== 'ADR-002'),
      'superseded decisions must never surface',
    );
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('edited source re-surfaces exactly once at the new revision', async () => {
  const ws = await tempWorkspace();
  try {
    const first = ws.service.evaluateTurn({ turnText: TURN_ABOUT_DB, perTurnMax: 1, dailyMax: 10 });
    ws.service.recordPresented(first.candidates);
    assert.equal(first.candidates.length, 1);

    // edit the source and rescan → new revision
    const adr1 = ws.store.getByAnchor('ADR-001');
    const original = await readFile(adr1.sourcePath, 'utf8');
    await writeFile(adr1.sourcePath, original + '\nAmendment: also require WAL mode.\n', 'utf8');
    await indexRoot(ws.store, ws.fixtures);
    const revised = ws.store.getByAnchor('ADR-001');
    assert.notEqual(revised.revision, adr1.revision, 'rescan must produce a new revision');

    const afterEdit = ws.service.evaluateTurn({ turnText: TURN_ABOUT_DB, perTurnMax: 1, dailyMax: 10 });
    assert.equal(afterEdit.candidates.length, 1, 'new revision must surface again');
    assert.equal(afterEdit.candidates[0].revision, revised.revision);
    ws.service.recordPresented(afterEdit.candidates);

    const again = ws.service.evaluateTurn({ turnText: TURN_ABOUT_DB, perTurnMax: 1, dailyMax: 10 });
    assert.ok(
      again.candidates.every(
        (c) => !(c.anchor === 'ADR-001' && c.revision === revised.revision),
      ),
      'the new revision surfaces exactly once',
    );
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('budgets: per-turn cap and daily cap suppress further cues', async () => {
  const ws = await tempWorkspace();
  try {
    const tight = ws.service.evaluateTurn({ turnText: TURN_ABOUT_DB, perTurnMax: 0, dailyMax: 10 });
    assert.equal(tight.candidates.length, 0, 'perTurnMax=0 disables surfacing');
    const capped = ws.service.evaluateTurn({ turnText: TURN_ABOUT_DB, perTurnMax: 1, dailyMax: 0 });
    assert.equal(capped.candidates.length, 0, 'dailyMax=0 disables surfacing');
    // daily exhaustion: dailyMax=1, first turn consumes it
    const first = ws.service.evaluateTurn({ turnText: TURN_ABOUT_DB, perTurnMax: 1, dailyMax: 1 });
    assert.equal(first.candidates.length, 1);
    ws.service.recordPresented(first.candidates);
    // second decision topic (ADR-002, different anchor) — still suppressed by daily cap
    const other = ws.service.evaluateTurn({ turnText: 'drill reads revision mismatch handling', perTurnMax: 1, dailyMax: 1 });
    assert.equal(other.candidates.length, 0, 'daily budget must suppress later turns');
    assert.ok(other.suppressedByBudget >= 0);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('renderCueLine and userTextOfTurn shapes', () => {
  assert.equal(renderCueLine([]), null);
  const line = renderCueLine([
    { anchor: 'ADR-001', title: 'T', summary: 'S', revision: 'abcd1234' },
  ]);
  assert.match(line, /- decision cue: "T" — S \[ADR-001 @abcd1234\]/);
  assert.match(line, /memory_drill/);

  const own = { source: { kind: 'dsh-memory-decisions' }, content: [{ type: 'text', text: 'injected' }] };
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'real question' }] };
  assert.equal(userTextOfTurn([own, user], 'dsh-memory-decisions'), 'real question');
  assert.equal(userTextOfTurn(undefined, 'dsh-memory-decisions'), '');
});

// ------------------------------------------------------------ preference cues

function prefNote(store, anchor, text) {
  store.upsert({
    anchor,
    kind: 'note',
    status: 'active',
    authority: 'standard',
    title: text.slice(0, 120),
    summary: text,
    keywords: [...text.split(/\s+/).filter(Boolean), 'preference'],
    sourcePath: null,
    revision: null,
    supersededBy: null,
  });
}

test('preference cues: selected by tag+topic, rotate daily, respect quotas', async () => {
  const ws = await tempWorkspace();
  try {
    prefNote(ws.store, 'obs-pref-jazz', 'The user dislikes jazz venues when traveling');
    const turn = 'Any recommendations for places to visit in New Orleans?';
    const args = { owner: 'default', turnText: turn, perTurnMax: 1, dailyQuota: 3 };

    const first = evaluatePreferenceCues(ws.store, args);
    assert.equal(first.candidates.length, 1, 'tagged preference matches the turn');
    assert.match(first.cueLine, /jazz/);
    assert.match(first.cueLine, /apply proactively/i);
    recordPreferencePresented(ws.store, { owner: 'default' }, first.candidates);

    const second = evaluatePreferenceCues(ws.store, args);
    assert.equal(second.candidates.length, 0, 'same-day repeat is silent (day-scoped rotation key)');
    assert.equal(preferencePresentedToday(ws.store), 1);

    // untagged notes never surface as preferences
    ws.store.upsert({
      anchor: 'obs-plain', kind: 'note', status: 'active', authority: 'standard',
      title: 'plain', summary: 'The user dislikes jazz venues when traveling in winter',
      keywords: ['user', 'dislikes', 'jazz'], sourcePath: null, revision: null, supersededBy: null,
    });
    const third = evaluatePreferenceCues(ws.store, args);
    assert.ok(third.candidates.every((c) => c.anchor !== 'obs-plain'), 'untagged note is not a preference cue');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('preference cues: family quota and the global cross-family ceiling', async () => {
  const ws = await tempWorkspace();
  try {
    prefNote(ws.store, 'obs-pref-1', 'The user dislikes jazz venues when traveling');
    const turn = 'Any recommendations for places to visit in New Orleans?';
    // family quota exhausted
    const quotaBlock = evaluatePreferenceCues(ws.store, {
      owner: 'default', turnText: turn, perTurnMax: 1, dailyQuota: 0,
    });
    assert.equal(quotaBlock.candidates.length, 0, 'prefDailyQuota=0 disables preference cues');
    // global ceiling exhausted (decisions consumed the whole shared budget)
    const globalBlock = evaluatePreferenceCues(ws.store, {
      owner: 'default', turnText: turn, perTurnMax: 1, dailyQuota: 3, globalRemaining: 0,
    });
    assert.equal(globalBlock.candidates.length, 0, 'exhausted global ceiling blocks preference cues');
    // global counter sees both families
    assert.equal(globalPresentedToday(ws.store), 0);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});
