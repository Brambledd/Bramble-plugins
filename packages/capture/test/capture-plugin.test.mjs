// Capture plugin integration test: pre-step buffering → pass firing →
// store writes, with a stubbed llm service and host module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, __testHooks } from '../index.js';

function makeStubCtx(llmFacts) {
  const tools = [];
  const sections = [];
  const disposers = [];
  const warns = [];
  const handlers = new Map();
  const answer = JSON.stringify({ facts: llmFacts });
  const ctx = {
    logger: { info() {}, warn(m) { warns.push(m); }, error() {} },
    tools: { register(t) { tools.push(t); } },
    systemPrompt: { section(s) { sections.push(s); } },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
    },
    llm: {
      // Real StreamChunk protocol shapes (see dsh-llm types.ts)
      async *stream(options) {
        assert.equal(options.purpose, 'bramble-memory-capture');
        assert.ok(Array.isArray(options.messages));
        assert.match(options.system, /STRICT JSON/);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: answer };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
        yield { type: 'finish', reason: 'stop' };
      },
    },
  };
  const preStep = async (decision) => {
    for (const h of handlers.get('agent/pre-step') ?? []) {
      const out = await h({ step: 1, signal: new AbortController().signal }, async () => decision);
      if (out !== undefined) decision = out;
    }
    return decision;
  };
  return { ctx, tools, disposers, preStep, warns };
}

// Minimal BlockAssembler double fed with the same chunk protocol.
class FakeBlockAssembler {
  #texts = [];
  #open = null;
  push(chunk) {
    if (chunk.type === 'text-delta') this.#open = (this.#open ?? '') + chunk.text;
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      this.#texts.push(chunk.block.text);
      this.#open = null;
    }
  }
  blocks() {
    return this.#texts.map((text) => ({ type: 'text', text }));
  }
}

test('auto capture: two buffered turns trigger a pass that writes facts', async () => {
  __testHooks.setLlmModuleLoader(async () => ({
    createUserMessage: (input) => ({ role: 'user', content: input.content, source: input.source }),
    BlockAssembler: FakeBlockAssembler,
  }));
  const dir = await mkdtemp(join(tmpdir(), 'dsh-capture-e2e-'));
  const facts = [
    'The user is migrating their blog from WordPress to Astro',
    'The user photographs with a Fuji X100V on weekends',
  ];
  const { ctx, preStep, disposers } = makeStubCtx(facts);
  try {
    apply(ctx, {
      dbPath: join(dir, 'evidence.sqlite'),
      autoCapture: true,
      everyNTurns: 2,
      dailyMax: 10,
      timeoutMs: 5000,
    });
    const userTurn = (text) => ({
      kind: 'ok',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    });
    await preStep(userTurn("By the way, I'm migrating my blog to Astro these days"));
    await preStep(userTurn('Also I take photos with my Fuji X100V on weekends'));
    // pass is fire-and-forget; give it a moment
    await new Promise((r) => setTimeout(r, 120));
    const { EvidenceStore } = await import('../../core/src/store.js');
    const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
    const stats = store.stats();
    assert.equal(stats.total, 2, `expected 2 captured facts, got ${stats.total}`);
    const hits = store.search({ query: 'blog Astro photograph Fuji', limit: 5 });
    assert.ok(hits.items.length >= 1, 'captured facts are retrievable');
    assert.ok(hits.items.every((r) => r.anchor.startsWith('cap-')));
    store.close();
    for (const d of disposers) d();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('auto capture disabled: no buffering, no passes', async () => {
  const { ctx, preStep, warns, disposers } = makeStubCtx(['fact']);
  let passCount = 0;
  __testHooks.setLlmModuleLoader(async () => {
    passCount += 1;
    return null;
  });
  const dir = await mkdtemp(join(tmpdir(), 'dsh-capture-off-'));
  try {
    apply(ctx, { dbPath: join(dir, 'evidence.sqlite'), autoCapture: false });
    for (let i = 0; i < 5; i += 1) {
      await preStep({ kind: 'ok', messages: [{ role: 'user', content: [{ type: 'text', text: 'some durable fact here' }] }] });
    }
    assert.equal(passCount, 0);
  } finally {
    for (const d of disposers) d();
    await rm(dir, { recursive: true, force: true });
  }
});
