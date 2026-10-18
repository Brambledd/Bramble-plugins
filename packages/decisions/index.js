// @local/dsh-memory-decisions — DSH plugin entry (M2: decision cues).
//
// Surfaces accepted decisions ONCE per revision at judgment points: on the
// first step of each turn, the user's message text is searched against the
// decision kind of the shared evidence index; unconsumed accepted decisions
// are injected as a compact cue line (agent may drill for the verified
// full record). Superseded/retired decisions never surface; the successor
// revision surfaces again exactly once.
//
// Injection mechanism mirrors @deepseek-ai/dsh-time-context: an
// `agent/pre-step` listener appends a source-attributed user message to the
// outgoing request, and the consumption ledger guarantees once-per-revision.
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { EvidenceStore } from '@local/dsh-memory-core/store';
import { createDecisionCueService, userTextOfTurn } from './src/cue-service.js';

export const name = 'dsh-memory-decisions';

export const inject = ['agents'];

const DEFAULTS = {
  perTurnMax: 1,
  dailyMax: 10,
  minTurnChars: 4,
};

export const Config = z.object({
  dbPath: z.string().description('Path of the SQLite evidence index shared with dsh-memory-core.'),
  owner: z.string().description('Consumption-ledger owner (single-user default: "default").'),
  perTurnMax: z.number().description('Maximum decision cues injected per turn.'),
  dailyMax: z.number().description('Maximum decision cues injected per UTC day (0 disables).'),
  enabled: z.boolean().description('Master switch (config-level kill switch).'),
});

function resolveConfig(config) {
  const cfg = config ?? {};
  if (typeof cfg.dbPath !== 'string' || cfg.dbPath.length === 0) {
    throw new Error('dsh-memory-decisions requires config `dbPath` (shared with dsh-memory-core)');
  }
  return {
    dbPath: cfg.dbPath,
    owner: typeof cfg.owner === 'string' && cfg.owner.length > 0 ? cfg.owner : 'default',
    perTurnMax: clampInt(cfg.perTurnMax, 0, 5, DEFAULTS.perTurnMax),
    dailyMax: clampInt(cfg.dailyMax, 0, 1000, DEFAULTS.dailyMax),
    enabled: cfg.enabled !== false,
  };
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const store = new EvidenceStore(cfg.dbPath);
  const service = createDecisionCueService(store, { owner: cfg.owner });

  ctx.effect(() => () => store.close());

  if (!cfg.enabled || cfg.perTurnMax === 0 || cfg.dailyMax === 0) {
    ctx.logger?.info?.('dsh-memory-decisions: cue surfacing disabled by config');
    return;
  }

  ctx.on('agent/pre-step', async ({ turn, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;
    if (step !== 1) return decision; // judge at turn open only — never mid-turn
    const turnText = userTextOfTurn(decision.messages, name);
    if (turnText.length < DEFAULTS.minTurnChars) return decision;
    const { candidates, cueLine } = service.evaluateTurn({
      turnText,
      perTurnMax: cfg.perTurnMax,
      dailyMax: cfg.dailyMax,
    });
    if (candidates.length === 0) return decision;
    service.recordPresented(candidates); // once per (owner, anchor, revision)
    const message = createUserMessage({
      content: [{ type: 'text', text: cueLine }],
      source: {
        kind: name,
        form: 'snapshot',
        sections: [{ name: 'decision-cues', text: cueLine }],
      },
    });
    return { ...decision, messages: [...decision.messages, message] };
  });
}
