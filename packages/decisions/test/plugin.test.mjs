// Plugin-level tests: apply() registers the agent/pre-step listener with a
// stub Cordis event bus; the full turn flow (evaluate → record → inject)
// runs end to end against real fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

function makeStubCtx() {
  const listeners = new Map(); // event → [handler]
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const d = fn();
      disposers.push(typeof d === 'function' ? d : () => {});
      return () => {};
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const arr = listeners.get(event) ?? [];
        const i = arr.indexOf(handler);
        if (i >= 0) arr.splice(i, 1);
      };
    },
  };
  return { ctx, listeners, disposers };
}

async function runPreStep(listeners, { turn = 1, step = 1, messages = [], signal = { aborted: false } }) {
  const handlers = listeners.get('agent/pre-step') ?? [];
  assert.ok(handlers.length >= 1, 'agent/pre-step listener must be registered');
  const chain = async (index) => {
    if (index >= handlers.length) return { kind: 'proceed', messages };
    const handler = handlers[index];
    return handler({ agent: null, turn, step, signal }, () => chain(index + 1));
  };
  return chain(0);
}

function userMsg(text) {
  return {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  };
}

test('pre-step injects a cue once per revision and goes silent afterwards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-decisions-plugin-'));
  const fixtures = join(dir, 'knowledge');
  await cp(new URL('./fixtures', import.meta.url), fixtures, { recursive: true });
  const { ctx, listeners, disposers } = makeStubCtx();

  // index the fixtures through a temp core store first (decisions plugin only opens the db)
  const { EvidenceStore } = await import('@local/dsh-memory-core/store');
  const { indexRoot } = await import('@local/dsh-memory-core/scanner');
  const dbPath = join(dir, 'evidence.sqlite');
  {
    const store = new EvidenceStore(dbPath);
    await indexRoot(store, fixtures);
    store.close();
  }

  apply(ctx, { dbPath, perTurnMax: 1, dailyMax: 10 });
  try {
    const turnText = 'Which database driver should we use for the new evidence store?';
    const first = await runPreStep(listeners, { messages: [userMsg(turnText)] });
    const injectedFirst = first.messages.filter(
      (m) => m?.source?.kind === 'dsh-memory-decisions',
    );
    assert.equal(injectedFirst.length, 1, 'first turn must inject one cue message');
    assert.match(injectedFirst[0].content[0].text, /ADR-001/);
    assert.match(injectedFirst[0].content[0].text, /memory_drill/);

    const second = await runPreStep(listeners, { messages: [userMsg(turnText)] });
    const injectedSecond = second.messages.filter(
      (m) => m?.source?.kind === 'dsh-memory-decisions',
    );
    assert.ok(
      injectedSecond.every((m) => !m.content[0].text.includes('ADR-001')),
      'the surfaced revision of ADR-001 must stay silent',
    );

    // non-matching topic injects nothing
    const offTopic = await runPreStep(listeners, {
      messages: [userMsg('What color should the login button be?')],
    });
    assert.equal(
      offTopic.messages.filter((m) => m?.source?.kind === 'dsh-memory-decisions').length,
      0,
    );

    // step > 1 never injects
    const laterStep = await runPreStep(listeners, {
      step: 3,
      messages: [userMsg(turnText)],
    });
    assert.equal(
      laterStep.messages.filter((m) => m?.source?.kind === 'dsh-memory-decisions').length,
      0,
    );
  } finally {
    for (const d of disposers) d();
    await rm(dir, { recursive: true, force: true });
  }
});

test('disabled config registers no listener', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-decisions-off-'));
  const { ctx, listeners, disposers } = makeStubCtx();
  apply(ctx, { dbPath: join(dir, 'evidence.sqlite'), enabled: false });
  try {
    assert.equal((listeners.get('agent/pre-step') ?? []).length, 0);
  } finally {
    for (const d of disposers) d();
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing dbPath throws', async () => {
  const { ctx } = makeStubCtx();
  assert.throws(() => apply(ctx, {}), /dbPath/);
});
