// Event store tests: idempotent marking, tombstone hard-forget with
// re-mark suppression, time-windowed query, half-life ranking, open loops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, computeEventKey } from '../src/event-store.js';

function tempStore() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-events-')).then((dir) => ({
    dir,
    store: new EventStore(join(dir, 'events.sqlite')),
  }));
}

test('mark is idempotent per source coordinate (explicit key and derived key)', async () => {
  const ws = await tempStore();
  try {
    const first = ws.store.mark({
      title: 'Promised to send the migration plan',
      kind: 'commitment',
      occurredAt: '2026-10-18T10:00:00Z',
      sourceKey: 'session-42/turn-3',
    });
    assert.equal(first.inserted, true);
    const repeat = ws.store.mark({
      title: 'Promised to send the migration plan',
      kind: 'commitment',
      occurredAt: '2026-10-18T10:00:00Z',
      sourceKey: 'session-42/turn-3',
    });
    assert.equal(repeat.inserted, false);
    assert.equal(repeat.event.eventKey, first.event.eventKey);
    assert.equal(ws.store.stats().total, 1);

    // derived-key idempotency: same kind|time|title triple → same key
    const d1 = ws.store.mark({ title: 'Deploy finished', kind: 'milestone', occurredAt: '2026-10-18T11:00:00Z' });
    const d2 = ws.store.mark({ title: 'Deploy finished', kind: 'milestone', occurredAt: '2026-10-18T11:00:00Z' });
    assert.equal(d2.inserted, false);
    // different title → different coordinate
    const d3 = ws.store.mark({ title: 'Deploy finished (v2)', kind: 'milestone', occurredAt: '2026-10-18T11:00:00Z' });
    assert.equal(d3.inserted, true);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('forget is hard: row removed, coordinate suppressed forever', async () => {
  const ws = await tempStore();
  try {
    const { event } = ws.store.mark({
      title: 'Sensitive incident detail',
      kind: 'incident',
      occurredAt: '2026-10-18T09:00:00Z',
      sourceKey: 'incident-7',
    });
    const forgotten = ws.store.forget(event.eventKey);
    assert.equal(forgotten.forgotten, true);
    assert.equal(ws.store.get(event.eventKey), null);
    // re-forget is idempotent, reports already forgotten
    const again = ws.store.forget(event.eventKey);
    assert.equal(again.alreadyForgotten, true);
    // re-marking the same coordinate is suppressed (tombstone fence)
    const suppressed = ws.store.mark({
      title: 'Sensitive incident detail',
      kind: 'incident',
      occurredAt: '2026-10-18T09:00:00Z',
      sourceKey: 'incident-7',
    });
    assert.equal(suppressed.suppressed, true);
    assert.equal(suppressed.event, null);
    assert.equal(ws.store.stats().tombstones, 1);
    // full-text search no longer finds it
    assert.equal(ws.store.search({ query: 'sensitive incident' }).length, 0);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('forget by sourceKey forgets the same row as by eventKey (agent-quote safety)', async () => {
  const ws = await tempStore();
  try {
    const { event } = ws.store.mark({
      title: 'Quarterly review promised',
      kind: 'commitment',
      occurredAt: '2026-10-18T09:00:00Z',
      sourceKey: 'plan/42',
    });
    // forgetting by the source coordinate resolves to the same event key
    const bySource = ws.store.forget('plan/42');
    assert.equal(bySource.forgotten, true);
    assert.equal(bySource.eventKey, event.eventKey);
    assert.equal(ws.store.get(event.eventKey), null);
    // re-mark suppressed regardless of which spelling is used
    const suppressed = ws.store.mark({
      title: 'Quarterly review promised',
      kind: 'commitment',
      occurredAt: '2026-10-18T09:00:00Z',
      sourceKey: 'plan/42',
    });
    assert.equal(suppressed.suppressed, true);
    // unknown coordinate reports not_found instead of a silent tombstone
    const missing = ws.store.forget('does/not/exist');
    assert.equal(missing.forgotten, false);
    assert.equal(missing.error, 'not_found');
    assert.equal(ws.store.stats().tombstones, 1, 'unknown keys must not create tombstones');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('time-windowed search and half-life ranking', async () => {
  const ws = await tempStore();
  try {
    ws.store.mark({ title: 'old deployment freeze note', kind: 'observation', occurredAt: '2025-01-01T00:00:00Z', sourceKey: 'e-old' });
    ws.store.mark({ title: 'fresh deployment freeze note', kind: 'observation', occurredAt: '2026-10-17T00:00:00Z', sourceKey: 'e-new' });
    // window excludes the old one
    const window = ws.store.search({ since: '2026-01-01T00:00:00Z', until: '2026-12-31T00:00:00Z' });
    assert.equal(window.length, 1);
    assert.match(window[0].title, /fresh/);
    // lexical tie broken by recency decay
    const ranked = ws.store.search({ query: 'deployment freeze note' });
    assert.ok(ranked.length >= 2);
    assert.match(ranked[0].title, /fresh/, 'recent event must outrank the 21-month-old one');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('open loops: due commitments are listed until they pass the window', async () => {
  const ws = await tempStore();
  try {
    ws.store.mark({
      title: 'Send the quarterly report',
      kind: 'commitment',
      occurredAt: '2026-10-01T00:00:00Z',
      dueAt: '2026-10-18T00:00:00Z',
      sourceKey: 'loop-1',
    });
    const due = ws.store.dueOpenLoops('2026-10-18T12:00:00Z');
    assert.equal(due.length, 1);
    assert.equal(due[0].title, 'Send the quarterly report');
    // not yet due
    assert.equal(ws.store.dueOpenLoops('2026-10-17T00:00:00Z').length, 0);
    assert.equal(ws.store.stats().openLoops >= 1, true);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('computeEventKey is deterministic and coordinate-scoped', () => {
  const a = computeEventKey({ sourceKey: 'x', title: 't', kind: 'k', occurredAt: 'o' });
  const b = computeEventKey({ sourceKey: 'x', title: 'different title', kind: 'k', occurredAt: 'o' });
  assert.equal(a, b, 'explicit sourceKey dominates the coordinate');
  const c = computeEventKey({ title: 't', kind: 'k', occurredAt: 'o' });
  const d = computeEventKey({ title: 't', kind: 'k', occurredAt: 'o' });
  assert.equal(c, d);
  const e = computeEventKey({ title: 't2', kind: 'k', occurredAt: 'o' });
  assert.notEqual(c, e);
});
