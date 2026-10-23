// @local/dsh-memory-capture — DSH plugin entry (automatic memory capture).
//
// Listens at turn boundaries, buffers the user's messages, and every N turns
// runs an LLM extraction pass over the buffer: durable facts are deduplicated
// against the evidence store, redacted (lessons' secret patterns), and
// written as kind:'note' raw material. This is the productized equivalent of
// the Bemula consolidation pass — the layer that bridges vocabulary gaps
// between how facts are said and how they are later asked.
//
// Host packages are PEERS (never dependencies — INC-20261022-01) and the
// dsh-llm import is lazy + defensive: when the llm service or its symbols are
// unavailable the plugin logs once and stays idle; memory tools keep working.
import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { EvidenceStore } from '../core/src/store.js';
import {
  captureSystemPrompt,
  captureUserPrompt,
  runCapturePass,
  todayCapturedCount,
} from './src/capture-service.js';

export const name = 'dsh-memory-capture';

export const inject = ['llm'];

const DEFAULTS = {
  everyNTurns: 8,
  maxFactsPerPass: 6,
  dailyMax: 40,
  maxBufferTurns: 24,
  maxTurnChars: 2000,
  timeoutMs: 45_000,
};

export const Config = z.object({
  dbPath: z.string().description('Path of the SQLite evidence index shared with dsh-memory-core.'),
  autoCapture: z.boolean().description('Master switch: extract and store durable facts automatically at turn boundaries.'),
  everyNTurns: z.number().description('Run one extraction pass every N user turns.'),
  maxFactsPerPass: z.number().description('Maximum facts written per extraction pass.'),
  dailyMax: z.number().description('Maximum captured facts per UTC day (0 disables).'),
  maxTurnChars: z.number().description('Per-turn character cap when buffering.'),
  timeoutMs: z.number().description('LLM extraction pass timeout in milliseconds.'),
  provider: z.string().description('Optional LLM route provider override.'),
  model: z.string().description('Optional LLM route model override.'),
  redactSecrets: z.boolean().description('Redact API keys, tokens, emails, IPs before storing.'),
});

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveConfig(config) {
  const cfg = config ?? {};
  return {
    dbPath:
      typeof cfg.dbPath === 'string' && cfg.dbPath.length > 0
        ? cfg.dbPath
        : join(homedir(), '.dsh', 'memory', 'evidence.sqlite'),
    autoCapture: cfg.autoCapture !== false,
    everyNTurns: clampInt(cfg.everyNTurns, 2, 50, DEFAULTS.everyNTurns),
    maxFactsPerPass: clampInt(cfg.maxFactsPerPass, 1, 12, DEFAULTS.maxFactsPerPass),
    dailyMax: clampInt(cfg.dailyMax, 0, 500, DEFAULTS.dailyMax),
    maxTurnChars: clampInt(cfg.maxTurnChars, 200, 8000, DEFAULTS.maxTurnChars),
    timeoutMs: clampInt(cfg.timeoutMs, 5_000, 300_000, DEFAULTS.timeoutMs),
    provider: typeof cfg.provider === 'string' && cfg.provider.length > 0 ? cfg.provider : undefined,
    model: typeof cfg.model === 'string' && cfg.model.length > 0 ? cfg.model : undefined,
    redactSecrets: cfg.redactSecrets !== false,
  };
}

/** Genuine user text only: user role, no plugin-attributed injections. */
function turnUserText(decision) {
  const parts = [];
  for (const message of decision?.messages ?? []) {
    if (message?.source) continue; // plugin-injected (cues, time-context, ...)
    if (message?.role && message.role !== 'user') continue;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

function loadLlmModuleDefault() {
  return import('@deepseek-ai/dsh-llm').catch((error) => {
    return null; // caller logs once via the plugin logger
  });
}

/** Test seam: override the host-module loader (integration tests). */
export const __testHooks = {
  setLlmModuleLoader(fn) {
    loadLlmModuleDefaultRef.fn = fn;
  },
};
const loadLlmModuleDefaultRef = { fn: loadLlmModuleDefault };

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const store = new EvidenceStore(cfg.dbPath);

  ctx.effect(() => () => store.close());

  if (!cfg.autoCapture || cfg.dailyMax === 0) {
    ctx.logger?.info?.('dsh-memory-capture: auto capture disabled by config');
    return;
  }

  // Lazy + defensive host-module load (createUserMessage / BlockAssembler).
  let llmModPromise = null;
  const loadLlmModule = () => {
    if (!llmModPromise) {
      llmModPromise = Promise.resolve()
        .then(() => loadLlmModuleDefaultRef.fn())
        .catch(() => null);
    }
    return llmModPromise;
  };

  const buffer = []; // {text, at}
  let busy = false;
  let failureCooldown = 0;

  const knownSummaries = () => {
    try {
      const { items } = store.search({ query: 'the user', limit: 30 });
      return (items ?? []).map((r) => String(r.summary ?? r.title ?? '').slice(0, 90)).filter(Boolean);
    } catch {
      return [];
    }
  };

  const runPass = async () => {
    const mod = await loadLlmModule();
    if (!mod?.createUserMessage || !mod?.BlockAssembler) {
      ctx.logger?.warn?.('dsh-memory-capture: @deepseek-ai/dsh-llm unavailable, capture idle');
      return false;
    }
    const turnTexts = buffer.map((b) => b.text);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const messages = [
        mod.createUserMessage({
          content: [{ type: 'text', text: captureUserPrompt(knownSummaries(), turnTexts) }],
          source: { kind: name, form: 'snapshot', sections: [{ name: 'capture-input', text: '' }] },
        }),
      ];
      const options = {
        messages,
        system: captureSystemPrompt(cfg.maxFactsPerPass),
        maxTokens: 800,
        purpose: 'bramble-memory-capture',
        signal: controller.signal,
      };
      if (cfg.provider) options.provider = cfg.provider;
      if (cfg.model) options.model = cfg.model;
      const assembler = new mod.BlockAssembler();
      for await (const chunk of ctx.llm.stream(options)) {
        controller.signal.throwIfAborted();
        assembler.push(chunk);
      }
      controller.signal.throwIfAborted();
      const answer = assembler
        .blocks()
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
      const result = await runCapturePass(store, async () => answer, {
        turnTexts,
        maxFacts: cfg.maxFactsPerPass,
        redact: cfg.redactSecrets,
      });
      buffer.length = 0;
      ctx.logger?.info?.(
        `dsh-memory-capture: ${result.written} captured, ${result.skipped} duplicates, ${result.redactions} redactions (${turnTexts.length} turns)`,
      );
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory-capture: capture pass failed, will retry: ${error?.message ?? error}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  // The real hook: evaluate after next() so the turn's messages are final.
  ctx.on('agent/pre-step', async (input, next) => {
    const decision = await next();
    if (decision?.kind === 'reject') return decision;
    if (busy || failureCooldown > 0) {
      if (failureCooldown > 0) failureCooldown -= 1;
      return decision;
    }
    const text = turnUserText(decision).slice(0, cfg.maxTurnChars);
    if (text.length < 8) return decision;
    buffer.push({ text, at: Date.now() });
    while (buffer.length > DEFAULTS.maxBufferTurns) buffer.shift();

    const trigger =
      buffer.length >= cfg.everyNTurns ||
      buffer.reduce((n, b) => n + b.text.length, 0) >= cfg.everyNTurns * cfg.maxTurnChars * 0.75;
    if (!trigger) return decision;

    if (todayCapturedCount(store) >= cfg.dailyMax) return decision; // budget exhausted; buffer keeps tail
    busy = true;
    runPass()
      .then((ok) => {
        if (!ok) failureCooldown = 2; // skip the next 2 turns before retrying
      })
      .finally(() => {
        busy = false;
      });
    return decision;
  });
}
