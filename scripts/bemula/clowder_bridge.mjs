#!/usr/bin/env node
// Clowder AI memory bridge for the Bemula benchmark.
//
// Same line-JSON-RPC protocol as bridge.mjs (the Python adapter speaks it
// unchanged), but the backend is the REAL Clowder pipeline: SqliteEvidenceStore
// + IndexBuilder (thread indexing, message passages, suppression machinery)
// + ForgetService (the benchmark-validated targeted-unlearning pipeline as
// shipped in the product). This is what lets the benchmark measure the
// product's deletion behavior instead of the adapter's.
//
// Threads mapping: each Bemula session is one Clowder thread. Messages are
// held in memory and indexed lazily through IndexBuilder.refreshThreadIndex
// (passages + summaries) on the first search/forget/list after new observes —
// so every retrieval and every suppression goes through the real index paths.
//
// Operations (superset of bridge.mjs):
//   {op:"reset"}                                  -> {ok:true}
//   {op:"observe", speaker, text, timestamp,
//      sessionId, turnIndex}                      -> {ok:true, anchor}
//   {op:"flush"}                                  -> {ok:true, indexed}
//   {op:"search", query, limit}                   -> {ok:true, results:[...]}
//   {op:"forget", scope, targets, since, until,
//      replacement, evidenceScope}                -> {ok:true, ...ForgetResult}
//   {op:"remove", anchors:[...]}                  -> {ok:true, removed}
//   {op:"list"} / {op:"stats"}                    -> compatibility
//   {op:"event"/"eventSearch"/"put"}              -> stubs (adapter compat)
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const CLOWDER_DIST = process.env.CLOWDER_DIST ?? 'E:/ClowderAI/clowder-ai/packages/api/dist';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const distUrl = (p) => pathToFileURL(`${CLOWDER_DIST}/${p}`).href;
const { SqliteEvidenceStore } = await import(distUrl('domains/memory/SqliteEvidenceStore.js'));
const { IndexBuilder } = await import(distUrl('domains/memory/IndexBuilder.js'));
const { ForgetService } = await import(distUrl('domains/memory/forget/ForgetService.js'));
const { VectorStore } = await import(distUrl('domains/memory/VectorStore.js'));

// Hash-style embedding service — same principle as Bramble's HashEmbedding:
// deterministic character-trigram hashing into a fixed-dim vector. Zero
// network, zero native deps, restores the semantic lane (variant-wording
// matches) that lexical-only retrieval misses.
const DIM = 256;
class HashEmbeddingService {
  constructor() {
    this.ready = true;
  }
  async load() {}
  async embed(texts) {
    return texts.map((t) => this.embedOne(t));
  }
  embedOne(text) {
    const vec = new Float32Array(DIM);
    const clean = String(text ?? '').toLowerCase();
    const grams = new Set();
    for (let i = 0; i < clean.length - 2; i += 1) grams.add(clean.slice(i, i + 3));
    for (const g of grams) {
      const h = createHash('sha1').update(g).digest();
      const idx = ((h[0] << 8) | h[1]) % DIM;
      vec[idx] += h[2] % 2 === 0 ? 1 : -1;
    }
    // L2 normalize
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIM; i += 1) vec[i] /= norm;
    return vec;
  }
  isReady() {
    return this.ready;
  }
  async reprobeIfNeeded() {}
  getModelInfo() {
    return { modelId: 'hash-trigram', modelRev: 'v1', dim: DIM };
  }
  dispose() {}
}

// In-memory thread/message state fed by observe(); the IndexBuilder reads it
// through the injected callbacks, exactly like production wiring.
let dir;
let store;
let indexBuilder;
let forgetService;
let embedding;
let threads; // Map<threadId, ThreadSnapshot>
let messages; // Map<threadId, StoredMessageSnapshot[]>
let dirty; // Set<threadId> with un-flushed observes

// A RepoScanner stub that discovers nothing — the benchmark corpus lives in
// threads, not on disk; this keeps IndexBuilder from touching the filesystem.
const emptyScanner = { discover: async () => [], getExcludePatterns: () => [] };

function buildRuntime() {
  dir = mkdtempSync(join(tmpdir(), 'clowder-bemula-'));
  const docsRoot = join(dir, 'docs');
  mkdirSync(docsRoot, { recursive: true });
  const embeddingSvc = new HashEmbeddingService();
  embedding = embeddingSvc;
  store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'));
  threads = new Map();
  messages = new Map();
  dirty = new Set();
  indexBuilder = new IndexBuilder(
    store,
    docsRoot,
    undefined, // IndexBuilder embedDeps: passage vectors stay lexical (round-1 parity)
    undefined, // transcriptDataDir
    async () => [...threads.values()],
    async (threadId, limit) => (messages.get(threadId) ?? []).slice(-(limit ?? 2000)),
    undefined,
    emptyScanner,
  );
  forgetService = new ForgetService({
    store,
    dropEdgesForAnchors: async (anchors) => {
      await store.deleteEdgesForAnchors(anchors);
    },
    searchMessagePassages: async (query, limit = 20) => {
      const hits = store.searchPassages(query, limit);
      return hits
        .filter((h) => h.docAnchor.startsWith('thread-') && h.passageId.startsWith('msg-'))
        .map((h) => ({
          threadId: h.docAnchor.slice('thread-'.length),
          messageId: h.passageId.slice('msg-'.length),
          createdAt: h.createdAt ?? null,
          content: h.content ?? null,
        }));
    },
    suppressMessage: async (threadId, messageId) => {
      const lease = await indexBuilder.suppressMessagePassage(threadId, messageId);
      await indexBuilder.finalizeMessagePassageSuppression(lease);
    },
    listNonThreadDocs: async () => {
      await ensureInitialized();
      return store
        .getDb()
        .prepare("SELECT anchor, kind, summary FROM evidence_docs WHERE anchor NOT LIKE 'thread-%' ORDER BY anchor")
        .all();
    },
    listThreadSummaries: async () => {
      await flush();
      return store
        .getDb()
        .prepare("SELECT anchor, summary FROM evidence_docs WHERE anchor LIKE 'thread-%' ORDER BY anchor")
        .all();
    },
    blankThreadSummary: async (anchor) => {
      store
        .getDb()
        .prepare("UPDATE evidence_docs SET summary = '' WHERE anchor = ?")
        .run(anchor);
    },
    listMessagePassages: async () => {
      await flush();
      return store
        .getDb()
        .prepare("SELECT doc_anchor, passage_id, created_at, content FROM evidence_passages WHERE doc_anchor LIKE 'thread-%'")
        .all()
        .filter((r) => r.passage_id.startsWith('msg-'))
        .map((r) => ({
          threadId: r.doc_anchor.slice('thread-'.length),
          messageId: r.passage_id.slice('msg-'.length),
          createdAt: r.created_at ?? null,
          content: r.content ?? null,
        }));
    },
  });
}

async function ensureInitialized() {
  if (!store || !store['db']) await store?.initialize?.();
  if (store && store.getDb && !store.getDb()) await store.initialize();
  // Semantic lane (once): hash-trigram vectors in the store's own
  // evidence_vectors vec0 table.
  if (store && !store.__semanticWired) {
    store.__semanticWired = true;
    const vectorStore = new VectorStore(store.getDb(), DIM);
    vectorStore.initMeta(embedding.getModelInfo());
    store.setEmbedDeps({ embedding, vectorStore, mode: 'on' });
  }
}

async function flush() {
  await ensureInitialized();
  if (dirty.size === 0) return { ok: true, indexed: 0 };
  await indexBuilder.refreshThreadIndex({ force: true });
  const n = dirty.size;
  dirty.clear();
  return { ok: true, indexed: n };
}

async function handle(req) {
  switch (req.op) {
    case 'reset': {
      buildRuntime();
      await store.initialize();
      return { ok: true };
    }
    case 'observe': {
      await ensureInitialized();
      const sessionId = String(req.sessionId ?? 's');
      const turnIndex = Number(req.turnIndex ?? 0);
      const clean = String(req.text ?? '').trim();
      if (clean.length === 0) return { ok: true, anchor: `msg-${sessionId}-${turnIndex}`, skipped: true };
      if (!threads.has(sessionId)) {
        threads.set(sessionId, {
          id: sessionId,
          title: null,
          participants: ['user', 'assistant'],
          lastActiveAt: Date.now(),
        });
      }
      const list = messages.get(sessionId) ?? [];
      const msgId = `m${String(turnIndex).padStart(4, '0')}`;
      list.push({
        id: msgId,
        content: clean,
        threadId: sessionId,
        timestamp: req.timestamp ? Date.parse(req.timestamp) || Date.now() : Date.now(),
        ...(req.speaker === 'assistant' ? { catId: 'assistant' } : {}),
      });
      messages.set(sessionId, list);
      const t = threads.get(sessionId);
      t.lastActiveAt = Date.now();
      if (t.title === null && req.speaker !== 'assistant') {
        t.title = clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
      }
      dirty.add(sessionId);
      return { ok: true, anchor: `thread-${sessionId}#msg-${msgId}` };
    }
    case 'flush':
      return flush();
    case 'search': {
      await flush();
      const query = String(req.query ?? '');
      const limit = Math.min(20, Math.max(1, req.limit ?? 8));
      const out = [];
      // Message passages carry the conversation content.
      for (const p of store.searchPassages(query, limit)) {
        out.push({
          anchor: `${p.docAnchor}#${p.passageId}`,
          title: (p.content ?? '').slice(0, 120),
          summary: p.content ?? '',
          kind: 'thread',
          updatedAt: p.createdAt ?? null,
        });
      }
      // Doc-level evidence (thread summaries + F6 replacements).
      // Clowder's search signature: search(query, options) → EvidenceItem[].
      const docItems = await store.search(query, { limit });
      for (const item of docItems) {
        if (out.length >= limit) break;
        if (out.some((o) => o.anchor === item.anchor)) continue;
        out.push({
          anchor: item.anchor,
          title: item.title,
          summary: item.summary ?? item.title,
          kind: item.kind,
          updatedAt: item.updatedAt,
        });
      }
      // Retraction markers are ALWAYS appended (they are few): they carry
      // the answer-time deny-list policy for forgotten topics.
      const retractions = store
        .getDb()
        .prepare("SELECT anchor, title, summary FROM evidence_docs WHERE kind = 'retraction' ORDER BY anchor")
        .all();
      for (const r of retractions) {
        if (out.some((o) => o.anchor === r.anchor)) continue;
        out.push({
          anchor: r.anchor,
          title: r.title,
          summary: r.summary ?? '',
          kind: 'retraction',
          updatedAt: null,
        });
      }
      return { ok: true, results: out.slice(0, limit) };
    }
    case 'forget': {
      await flush();
      const result = await forgetService.execute({
        scope: req.scope ?? 'facts',
        targets: Array.isArray(req.targets) ? req.targets.map(String) : [],
        since: req.since,
        until: req.until,
        replacement: req.replacement,
        evidenceScope: req.evidenceScope ?? 'threads',
      });
      return { ok: true, ...result };
    }
    case 'remove': {
      await flush();
      const anchors = Array.isArray(req.anchors) ? req.anchors : [];
      let removed = 0;
      for (const anchor of anchors) {
        const msgMatch = /^thread-(.+)#msg-(.+)$/.exec(anchor);
        if (msgMatch) {
          const lease = await indexBuilder.suppressMessagePassage(msgMatch[1], msgMatch[2]);
          await indexBuilder.finalizeMessagePassageSuppression(lease);
          removed += 1;
          continue;
        }
        if (store.getByAnchor(anchor)) {
          await store.deleteByAnchor(anchor);
          removed += 1;
        }
      }
      return { ok: true, removed };
    }
    case 'put': {
      // Direct evidence write (F6 replacements land here if the adapter
      // chooses to write outside ForgetService).
      await ensureInitialized();
      const clean = String(req.text ?? '').trim();
      if (clean.length === 0) return { ok: true, skipped: true };
      const anchor = String(req.anchor ?? `infer-${Date.now()}`);
      await store.upsert([
        {
          anchor,
          kind: 'session',
          status: 'active',
          title: clean.slice(0, 120),
          summary: clean,
          keywords: Array.isArray(req.keywords) ? req.keywords : [],
          updatedAt: new Date().toISOString(),
        },
      ]);
      return { ok: true, anchor };
    }
    case 'list': {
      await flush();
      const rows = store
        .getDb()
        .prepare('SELECT anchor, kind, title, summary, keywords FROM evidence_docs ORDER BY anchor')
        .all();
      const passages = store.getDb().prepare('SELECT COUNT(*) AS n FROM evidence_passages').get();
      return {
        ok: true,
        items: rows.map((r) => ({ ...r, keywords: r.keywords ? r.keywords.split(',') : [] })),
        passages: passages.n,
      };
    }
    case 'stats':
      await flush();
      return { ok: true, evidence: store.stats(), threads: threads.size };
    case 'event':
      return { ok: true, inserted: false, suppressed: false, stub: true };
    case 'eventSearch':
      return { ok: true, events: [] };
    default:
      return { ok: false, error: `unknown op: ${req.op}` };
  }
}

buildRuntime();
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const trimmed = line.trim();
  if (trimmed.length === 0) continue;
  let response;
  try {
    response = await handle(JSON.parse(trimmed));
  } catch (error) {
    response = { ok: false, error: error.message };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
