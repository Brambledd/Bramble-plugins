// @local/dsh-memory-core — DSH plugin entry (Cordis apply shape).
//
// Registers three agent tools over the evidence store:
//   memory_search — BM25 full-text search over the derived evidence index.
//   memory_drill  — revision-verified source read (回源校验, fail-closed).
//   memory_stats  — index health snapshot (counts by kind/status).
//
// And injects a single system-prompt hint line (no memory dumping).
import z from '@deepseek-ai/schemastery';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EvidenceStore } from './src/store.js';
import { indexRoot, rebuildAll } from './src/scanner.js';
import { createEmbeddingBackend } from './src/embedding.js';
import { EVIDENCE_KINDS, INACTIVE_STATUSES } from './src/util.js';

export const name = 'dsh-memory-core';

export const inject = ['tools', 'systemPrompt'];

const DEFAULT_MAX_RESULTS = 8;
const HARD_MAX_RESULTS = 20;

/** Zero-config defaults: everything lives under ~/.dsh/memory by default. */
export function defaultDataDir() {
  return join(homedir(), '.dsh', 'memory');
}

/** Plugin configuration (all fields optional; resolved with defaults in apply). */
export const Config = z.object({
  dbPath: z.string().description('Absolute path of the SQLite evidence index (created if missing).'),
  roots: z.array(z.string()).description('Source roots to index on startup (truth side).'),
  maxResults: z.number().description('Default result limit for memory_search.'),
  reindexOnStart: z.boolean().description('Rescan configured roots at startup.'),
  promptHint: z.boolean().description('Inject the one-line memory-availability system prompt hint.'),
  vector: z.object({
    enabled: z.boolean().description('Enable the vector lane (hybrid RRF search).'),
    backend: z.string().description("Embedding backend: 'hash' (default, deterministic, offline) or 'openai' (OpenAI-compatible endpoint)."),
    baseUrl: z.string().description('openai backend: base URL of the embeddings endpoint.'),
    apiKeyEnv: z.string().description('openai backend: environment variable holding the API key.'),
    model: z.string().description('openai backend: embedding model id.'),
    dimensions: z.number().description('Vector dimensions (hash backend default 256).'),
    backfillBatch: z.number().description('How many documents to embed per startup backfill batch.'),
  }).description('Vector lane configuration.'),
});

const PROMPT_HINT =
  'A persistent memory evidence store is available: at judgment points (decisions, lessons, people, past events) call memory_search first, and memory_drill (with the revision returned by search) to read the verified source.';

function resolveConfig(config) {
  const cfg = config ?? {};
  const dbPath =
    typeof cfg.dbPath === 'string' && cfg.dbPath.length > 0
      ? cfg.dbPath
      : join(defaultDataDir(), 'evidence.sqlite');
  const roots = Array.isArray(cfg.roots)
    ? cfg.roots.filter((r) => typeof r === 'string' && r.length > 0)
    : [join(defaultDataDir(), 'knowledge')];
  const rawVector = typeof cfg.vector === 'object' && cfg.vector !== null ? cfg.vector : {};
  const vector = {
    ...rawVector,
    enabled: rawVector.enabled !== false,
    backfillBatch: clampInt(rawVector.backfillBatch, 0, 512, 64),
  };
  return {
    dbPath,
    roots,
    maxResults: clampInt(cfg.maxResults, 1, HARD_MAX_RESULTS, DEFAULT_MAX_RESULTS),
    reindexOnStart: cfg.reindexOnStart !== false,
    promptHint: cfg.promptHint !== false,
    vector,
  };
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

const searchOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results', 'matchMode'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['anchor', 'title', 'kind', 'status', 'revision', 'active'],
        properties: {
          anchor: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          revision: { type: 'string' },
          sourcePath: { type: 'string' },
          summary: { type: 'string' },
          supersededBy: { type: 'string' },
          active: { type: 'boolean' },
        },
      },
    },
    matchMode: { type: 'string' },
  },
};

const drillOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'anchor'],
  properties: {
    status: { type: 'string', enum: ['ok', 'not_available'] },
    anchor: { type: 'string' },
    revision: { type: 'string' },
    kind: { type: 'string' },
    docStatus: { type: 'string' },
    title: { type: 'string' },
    content: { type: 'string' },
    truncated: { type: 'boolean' },
    totalChars: { type: 'integer' },
    invalidationReason: { type: 'string' },
  },
};

export function apply(ctx, config) {
  const cfg = resolveConfig(config);

  const startup = (async () => {
    await mkdir(dirname(cfg.dbPath), { recursive: true });
    const store = new EvidenceStore(cfg.dbPath);
    if (cfg.reindexOnStart && cfg.roots.length > 0) {
      for (const root of cfg.roots) {
        await indexRoot(store, root).catch((error) => {
          ctx.logger?.warn?.(`memory-core: failed to index root ${root}: ${error.message}`);
        });
      }
    }
    // Vector lane: attach the backend, then backfill missing embeddings in
    // bounded batches (best effort — search degrades to BM25 without them).
    const embedding = createEmbeddingBackend(cfg.vector);
    if (embedding) {
      store.attachEmbedding(embedding);
      let budget = cfg.vector.backfillBatch;
      while (budget > 0) {
        const result = await store
          .embedBackfill({ batchSize: Math.min(32, budget) })
          .catch((error) => {
            ctx.logger?.warn?.(`memory-core: vector backfill failed: ${error.message}`);
            return { embedded: 0 };
          });
        if (result.embedded === 0) break;
        budget -= result.embedded;
      }
    }
    return store;
  })();

  const ready = startup.catch((error) => {
    ctx.logger?.error?.(`memory-core: failed to open evidence store: ${error.message}`);
    throw error;
  });

  async function withStore(fn) {
    const store = await ready;
    return fn(store);
  }

  if (cfg.promptHint) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'dsh-memory-core:hint',
        order: 90,
        text: PROMPT_HINT,
      }),
    );
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_search',
      description:
        'Search the persistent memory evidence store (decisions, lessons, people, past events, notes) with full-text search. Returns anchors plus content revisions; pass both to memory_drill to read the verified source. Use it at judgment points before re-deciding or re-asking.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'Free-text query; terms are matched against titles, summaries and keywords.',
          },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: [...EVIDENCE_KINDS] },
            description: 'Optional kind filter (e.g. ["decision","lesson"]).',
          },
          limit: {
            type: 'integer',
            description: `Maximum results (1-${HARD_MAX_RESULTS}).`,
          },
        },
      },
      output: {
        schema: searchOutputSchema,
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `memory search [${value.matchMode}]:\n` +
              (value.results.length === 0
                ? '  no evidence matched.'
                : value.results
                    .map(
                      (r) =>
                        `- [${r.kind}] ${r.title} (${r.anchor} @${r.revision}${r.active ? '' : ' [inactive]'})${r.summary ? ` — ${r.summary}` : ''}`,
                    )
                    .join('\n')),
          },
        ],
      },
      execute(args) {
        return withStore((store) => {
          const limit = clampInt(args.limit, 1, HARD_MAX_RESULTS, cfg.maxResults);
          return store.searchHybrid({
            query: args.query,
            kinds: args.kinds,
            limit,
          });
        }).then(({ items, matchMode }) => ({
          matchMode: matchMode ?? 'none',
          results: items.map((item) => ({
            anchor: item.anchor,
            title: item.title,
            kind: item.kind,
            status: item.status,
            revision: item.revision ?? '',
            sourcePath: item.sourcePath ?? '',
            summary: item.summary ?? '',
            supersededBy: item.supersededBy ?? '',
            active: !INACTIVE_STATUSES.has(item.status) && !item.supersededBy,
          })),
        }));
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Memory search',
        kind: 'other',
        rawInput: args,
      }),
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_drill',
      description:
        'Read one memory evidence document with source verification: re-hashes the source file and only returns content when it still matches the indexed revision. Pass the revision returned by memory_search as expectedRevision; a mismatch fails closed with an invalidationReason instead of returning stale content.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['anchor'],
        properties: {
          anchor: {
            type: 'string',
            description: 'Evidence anchor from memory_search (e.g. ADR-001).',
          },
          expectedRevision: {
            type: 'string',
            description:
              'Revision from memory_search — the full 64-char hex hash (an 8+ char unambiguous prefix is also accepted). A mismatch fails closed with invalidationReason instead of returning stale content.',
          },
          maxChars: {
            type: 'integer',
            description: 'Content cap in characters (default 8000, max 50000). Oversized documents return truncated=true with totalChars — read the source file directly if you need more.',
          },
        },
      },
      output: {
        schema: drillOutputSchema,
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.status === 'ok'
                ? `memory ${value.anchor} @${value.revision} (${value.kind}/${value.docStatus})${value.truncated ? ` [truncated ${value.content.length}/${value.totalChars} chars]` : ''}:\n${value.content}`
                : `memory ${value.anchor} unavailable: ${value.invalidationReason}`,
          },
        ],
      },
      execute(args) {
        const max =
          Number.isFinite(args.maxChars) && args.maxChars > 0
            ? Math.min(50_000, Math.floor(args.maxChars))
            : undefined;
        return withStore((store) =>
          store.drill({
            anchor: String(args.anchor ?? ''),
            expectedRevision:
              typeof args.expectedRevision === 'string' && args.expectedRevision.length > 0
                ? args.expectedRevision
                : undefined,
            maxChars: max,
          }),
        );
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Memory drill',
        kind: 'other',
        rawInput: args,
      }),
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_stats',
      description:
        'Snapshot of the memory evidence index: document counts by kind and status, cue-consumption ledger size, schema version and indexed roots. Useful after reindexing or for health checks.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: `memory index: ${JSON.stringify(value)}` },
        ],
      },
      execute() {
        return withStore((store) => store.stats());
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Memory stats',
        kind: 'other',
        rawInput: {},
      }),
    }),
  );

  // Lifecycle: close the SQLite handle when the context disposes. If the
  // store is still opening at dispose time, close it the moment it settles.
  ctx.effect(() => {
    let storeRef = null;
    let failed = false;
    ready.then(
      (store) => {
        storeRef = store;
      },
      () => {
        failed = true;
      },
    );
    const dispose = () => {
      if (storeRef) storeRef.close();
      else if (!failed) void ready.then((store) => store.close(), () => {});
    };
    return dispose;
  });
}

export { EvidenceStore, indexRoot, rebuildAll };
