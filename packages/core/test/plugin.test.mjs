// Plugin-level tests: verify apply() registers the three tools with working
// execute paths against a stub Cordis context, plus prompt hint + disposal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

function makeStubCtx() {
  const tools = [];
  const sections = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {
          const i = tools.indexOf(tool);
          if (i >= 0) tools.splice(i, 1);
        };
      },
    },
    systemPrompt: {
      section(def) {
        sections.push(def);
        return () => {
          const i = sections.indexOf(def);
          if (i >= 0) sections.splice(i, 1);
        };
      },
    },
    logger: {
      warn() {},
      error() {},
    },
    effect(fn) {
      const dispose = fn();
      disposers.push(typeof dispose === 'function' ? dispose : () => {});
      return () => {};
    },
  };
  return { ctx, tools, sections, disposers };
}

async function settle() {
  await new Promise((r) => setTimeout(r, 25));
}

test('apply registers memory tools and prompt hint; execute paths work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-'));
  const fixtures = join(dir, 'knowledge');
  await cp(new URL('./fixtures', import.meta.url), fixtures, { recursive: true });
  const { ctx, tools, sections, disposers } = makeStubCtx();

  apply(ctx, {
    dbPath: join(dir, 'evidence.sqlite'),
    roots: [fixtures],
    reindexOnStart: true,
    promptHint: true,
  });
  await settle();

  try {
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['memory_drill', 'memory_search', 'memory_stats']);

    assert.equal(sections.length, 1);
    assert.match(sections[0].text, /memory_search/);

    const search = tools.find((t) => t.name === 'memory_search');
    const drill = tools.find((t) => t.name === 'memory_drill');
    const stats = tools.find((t) => t.name === 'memory_stats');

    // search execute
    const hit = await search.execute({ query: 'sqlite driver', limit: 5 });
    assert.ok(hit.results.length >= 1);
    const row = hit.results.find((r) => r.anchor === 'ADR-001');
    assert.ok(row, 'ADR-001 must be findable');
    assert.equal(row.kind, 'decision');
    assert.equal(row.active, true);
    assert.match(hit.matchMode, /"/);

    // drill execute: ok + fail-closed
    const ok = await drill.execute({ anchor: 'ADR-001', expectedRevision: row.revision });
    assert.equal(ok.status, 'ok');
    assert.match(ok.content, /node:sqlite/);
    const stale = await drill.execute({ anchor: 'ADR-001', expectedRevision: 'zzz' });
    assert.equal(stale.status, 'not_available');
    assert.equal(stale.invalidationReason, 'stale_revision');

    // stats execute
    const statsValue = await stats.execute({});
    assert.equal(statsValue.total, 5);
    assert.equal(statsValue.byKind.decision, 3);

    // render smoke
    const rendered = search.output.render({}, hit);
    assert.match(rendered[0].text, /ADR-001/);
  } finally {
    for (const d of disposers) d();
    await rm(dir, { recursive: true, force: true });
  }
});

test('apply with promptHint disabled injects no system prompt section', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-'));
  const { ctx, tools, sections, disposers } = makeStubCtx();
  apply(ctx, { dbPath: join(dir, 'evidence.sqlite'), roots: [], promptHint: false });
  await settle();
  try {
    assert.equal(sections.length, 0);
    assert.equal(tools.length, 3);
    const stats = tools.find((t) => t.name === 'memory_stats');
    const value = await stats.execute({});
    assert.equal(value.total, 0);
  } finally {
    for (const d of disposers) d();
    await rm(dir, { recursive: true, force: true });
  }
});

test('apply without dbPath throws a configuration error', async () => {
  const { ctx } = makeStubCtx();
  assert.throws(() => apply(ctx, {}), /dbPath/);
});

test('disposal closes the store: later execute rejects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-'));
  const { ctx, tools, disposers } = makeStubCtx();
  apply(ctx, { dbPath: join(dir, 'evidence.sqlite'), roots: [], promptHint: false });
  await settle();
  const stats = tools.find((t) => t.name === 'memory_stats');
  await stats.execute({});
  for (const d of disposers) d();
  await settle();
  await assert.rejects(() => stats.execute({}), /not open|closed/i);
  await rm(dir, { recursive: true, force: true });
});
