// @local/dsh-memory-events — DSH plugin entry (M3b: temporal memory).
import z from '@deepseek-ai/schemastery';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventStore, EVENT_KINDS } from './src/event-store.js';

export const name = 'dsh-memory-events';

export const inject = ['tools', 'systemPrompt'];

export const Config = z.object({
  dbPath: z.string().description('Dedicated SQLite file for the event store (truth side).'),
  enabled: z.boolean().description('Master switch.'),
});

const PROMPT_HINT =
  'Temporal memory: record commitments, outcomes, milestones and incidents with event_mark (idempotent by source coordinate — prefer passing sourceKey). Query with event_search (time windows supported); commitments may carry dueAt for open-loop follow-up. event_forget hard-deletes and permanently suppresses an event coordinate — use only on the user\'s request.';

function resolveConfig(config) {
  const cfg = config ?? {};
  if (typeof cfg.dbPath !== 'string' || cfg.dbPath.length === 0) {
    throw new Error('dsh-memory-events requires config `dbPath`');
  }
  return { dbPath: cfg.dbPath, enabled: cfg.enabled !== false };
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);

  const startup = (async () => {
    await mkdir(dirname(cfg.dbPath), { recursive: true });
    return new EventStore(cfg.dbPath);
  })();
  const ready = startup.catch((error) => {
    ctx.logger?.error?.(`dsh-memory-events: failed to open event store: ${error.message}`);
    throw error;
  });
  const withStore = (fn) => ready.then(fn);

  ctx.effect(() => {
    let ref = null;
    let failed = false;
    ready.then((s) => { ref = s; }, () => { failed = true; });
    return () => {
      if (ref) ref.close();
      else if (!failed) void ready.then((s) => s.close(), () => {});
    };
  });

  if (!cfg.enabled) {
    ctx.logger?.info?.('dsh-memory-events: disabled by config');
    return;
  }

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'dsh-memory-events:hint',
      order: 92,
      text: PROMPT_HINT,
    }),
  );

  const register = (tool) => ctx.effect(() => ctx.tools.register(tool));

  register({
    name: 'event_mark',
    description:
      'Record an event in temporal memory (commitments, outcomes, milestones, incidents). Idempotent: the same source coordinate never duplicates. Returns suppressed=true when the coordinate was hard-forgotten.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'occurredAt'],
      properties: {
        title: { type: 'string', description: 'What happened / was promised (one line).' },
        occurredAt: { type: 'string', description: 'ISO-8601 timestamp of when it happened or was promised.' },
        kind: { type: 'string', enum: [...EVENT_KINDS], description: 'commitment | outcome | observation | milestone | incident.' },
        detail: { type: 'string', description: 'Optional context/body.' },
        dueAt: { type: 'string', description: 'Optional ISO-8601 follow-up time for commitments (open loop).' },
        sourceKey: { type: 'string', description: 'Stable source coordinate (session id + turn, task id). Makes the mark idempotent across retries.' },
        sourceNote: { type: 'string', description: 'Optional human-readable provenance.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.error
            ? `event mark failed: ${value.error}`
            : value.suppressed
              ? 'event mark suppressed (coordinate was hard-forgotten)'
              : value.inserted
                ? `event recorded (${value.event.title})`
                : `event already recorded (${value.event.title})`,
        },
      ],
    },
    execute(args) {
      return withStore((store) => {
        if (!/^(\d{4}-\d{2}-\d{2}T)/.test(String(args.occurredAt ?? ''))) {
          return { error: 'occurredAt must be an ISO-8601 timestamp' };
        }
        if (args.dueAt && !/^(\d{4}-\d{2}-\d{2}T)/.test(String(args.dueAt))) {
          return { error: 'dueAt must be an ISO-8601 timestamp' };
        }
        const result = store.mark({
          title: String(args.title ?? ''),
          kind: EVENT_KINDS.includes(args.kind) ? args.kind : 'observation',
          detail: args.detail ?? null,
          occurredAt: String(args.occurredAt ?? ''),
          dueAt: args.dueAt ?? null,
          sourceKey: args.sourceKey ?? null,
          sourceNote: args.sourceNote ?? null,
        });
        return result.suppressed
          ? { suppressed: true, inserted: false }
          : { inserted: result.inserted, event: result.event };
      });
    },
    presentCall: (args) => ({ card: 'generic', title: 'Mark event', kind: 'other', rawInput: args }),
  });

  register({
    name: 'event_search',
    description:
      'Query temporal memory by text and/or time window (since/until ISO-8601). Results are ranked with half-life recency decay; retired events are excluded unless requested.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional free-text filter over titles and details.' },
        kinds: { type: 'array', items: { type: 'string', enum: [...EVENT_KINDS] }, description: 'Optional kind filter.' },
        since: { type: 'string', description: 'Optional ISO-8601 lower bound on occurredAt (inclusive).' },
        until: { type: 'string', description: 'Optional ISO-8601 upper bound on occurredAt (inclusive).' },
        limit: { type: 'integer', description: 'Max results (1-50, default 20).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.events.length === 0
              ? 'no events matched'
              : value.events
                  .map((e) => `- [${e.kind}] ${e.occurredAt} ${e.title}${e.dueAt ? ` (due ${e.dueAt})` : ''}`)
                  .join('\n'),
        },
      ],
    },
    execute(args) {
      return withStore((store) => ({
        events: store.search({
          query: args.query,
          kinds: args.kinds,
          since: args.since,
          until: args.until,
          limit: Math.min(50, Math.max(1, Math.trunc(args.limit ?? 20) || 20)),
        }),
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: 'Search events', kind: 'other', rawInput: args }),
  });

  register({
    name: 'event_forget',
    description:
      "Hard-forget one event: removes it permanently and tombstones its coordinate so it can never be re-marked. Accepts the eventKey from event_mark/event_search OR the sourceKey you supplied at mark time. Use only when the user asks to forget. Irreversible.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['eventKey'],
      properties: {
        eventKey: { type: 'string', description: 'Event key (64-char hex) or source key of the event to forget.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.error
            ? `event forget failed: ${value.error}`
            : value.forgotten
              ? `event forgotten (${value.eventKey})`
              : `already forgotten (${value.eventKey})`,
        },
      ],
    },
    execute(args) {
      return withStore((store) => store.forget(String(args.eventKey ?? '')));
    },
    presentCall: (args) => ({ card: 'generic', title: 'Forget event', kind: 'other', rawInput: args }),
  });

  register({
    name: 'event_stats',
    description: 'Temporal memory snapshot: counts by kind, tombstones, open loops past due.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `events: ${JSON.stringify(value)}` }],
    },
    execute() {
      return withStore((store) => store.stats());
    },
    presentCall: () => ({ card: 'generic', title: 'Event stats', kind: 'other', rawInput: {} }),
  });
}
