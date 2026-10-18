// Plugin-level tests for dsh-memory-events against a stub context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

function makeStubCtx() {
  const tools = [];
  const sections = [];
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: (t) => { tools.push(t); return () => {}; } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    effect(fn) {
      const d = fn();
      disposers.push(typeof d === 'function' ? d : () => {});
      return () => {};
    },
  };
  return { ctx, tools, sections, disposers };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

test('event tools lifecycle: mark twice, search window, forget suppress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-events-plugin-'));
  const { ctx, tools, sections, disposers } = makeStubCtx();
  apply(ctx, { dbPath: join(dir, 'events.sqlite') });
  await settle();
  try {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['event_mark', 'event_search', 'event_forget', 'event_stats']) {
      assert.ok(byName[n], `${n} must be registered`);
    }
    assert.ok(sections.length >= 1);

    const first = await byName.event_mark.execute({
      title: 'Promised to review the plugin PR',
      kind: 'commitment',
      occurredAt: '2026-10-18T08:00:00Z',
      dueAt: '2026-10-20T08:00:00Z',
      sourceKey: 'plugin-test/turn-1',
    });
    assert.equal(first.inserted, true);
    const repeat = await byName.event_mark.execute({
      title: 'Promised to review the plugin PR',
      kind: 'commitment',
      occurredAt: '2026-10-18T08:00:00Z',
      sourceKey: 'plugin-test/turn-1',
    });
    assert.equal(repeat.inserted, false);

    const bad = await byName.event_mark.execute({ title: 'x', occurredAt: 'yesterday' });
    assert.equal(bad.error, 'occurredAt must be an ISO-8601 timestamp');

    const found = await byName.event_search.execute({ query: 'review the plugin PR' });
    assert.equal(found.events.length, 1);

    const forgotten = await byName.event_forget.execute({ eventKey: first.event.eventKey });
    assert.equal(forgotten.forgotten, true);
    const suppressed = await byName.event_mark.execute({
      title: 'Promised to review the plugin PR',
      kind: 'commitment',
      occurredAt: '2026-10-18T08:00:00Z',
      sourceKey: 'plugin-test/turn-1',
    });
    assert.equal(suppressed.suppressed, true);

    const stats = await byName.event_stats.execute({});
    assert.equal(stats.tombstones, 1);
  } finally {
    for (const d of disposers) d();
    await rm(dir, { recursive: true, force: true });
  }
});
