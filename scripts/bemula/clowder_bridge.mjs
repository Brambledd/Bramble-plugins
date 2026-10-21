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
const distUrl = (p) => pathToFileURL(`${CLOWDER_DIST}/${p}`).href;
const { SqliteEvidenceStore } = await import(distUrl('domains/memory/SqliteEvidenceStore.js'));
const { IndexBuilder } = await import(distUrl('domains/memory/IndexBuilder.js'));
const { ForgetService } = await import(distUrl('domains/memory/forget/ForgetService.js'));

// In-memory thread/message state fed by observe(); the IndexBuilder reads it
// through the injected callbacks, exactly like production wiring.
let dir;
let store;
let indexBuilder;
let forgetService;
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
  store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'));
  threads = new Map();
  messages = new Map();
  dirty = new Set();
  indexBuilder = new IndexBuilder(
    store,
    docsRoot,
    undefined, // embedDeps: lexical-only round
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
        .prepare("SELECT anchor, summary FROM evidence_docs WHERE anchor NOT LIKE 'thread-%' ORDER BY anchor")
        .all();
    },
  });
}

async function ensureInitialized() {
  if (!store || !store['db']) await store?.initialize?.();
  if (store && store.getDb && !store.getDb()) await store.initialize();
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
