#!/usr/bin/env node
// Bramble memory bridge for the Bemula benchmark.
//
// A long-lived Node process speaking line-delimited JSON-RPC over stdio:
// the Python adapter writes one request object per line, this process
// answers one response object per line. All state lives in a throwaway
// EvidenceStore (+ EventStore) rooted at a per-process temp directory, so
// `reset` is a wipe and nothing touches the user's real memory.
//
// Operations:
//   {op:"reset"}                                    -> {ok:true}
//   {op:"observe", speaker, text, timestamp,
//      sessionId, turnIndex}                        -> {ok:true, anchor}
//   {op:"search", query, limit}                     -> {ok:true, results:[{anchor,title,summary,kind}]}
//   {op:"remove", anchors:[...]}                    -> {ok:true, removed}
//   {op:"event", title, occurredAt, sourceKey,
//      detail}                                      -> {ok:true, inserted, suppressed}
//   {op:"eventSearch", query, limit}                -> {ok:true, events:[...]}
//   {op:"stats"}                                    -> {ok:true, ...store.stats()}
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { EvidenceStore } from '../../packages/core/src/store.js';
import { EventStore } from '../../packages/events/src/event-store.js';
import { computeRevision } from '../../packages/core/src/util.js';

const dir = mkdtempSync(join(tmpdir(), 'bramble-bemula-'));
const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
const events = new EventStore(join(dir, 'events.sqlite'));
const { HashEmbedding } = await import('../../packages/core/src/embedding.js');
store.attachEmbedding(new HashEmbedding({ dimensions: 256 }));

function observe({ speaker, text, timestamp, sessionId, turnIndex }) {
  const anchor = `turn-${sessionId}-${String(turnIndex).padStart(4, '0')}`;
  const clean = String(text ?? '').trim();
  if (clean.length === 0) return { ok: true, anchor, skipped: true };
  // Date tokens go into keywords (retrievable, deterministic filtering) but
  // NOT into summaries: timestamp text floods the trigram/vector lanes and
  // drowns the content signal (lesson from the F4 trace).
  const stamp = String(timestamp ?? '').trim();
  const item = {
    anchor,
    kind: 'note',
    status: 'active',
    authority: 'standard',
    title: clean.length > 120 ? `${clean.slice(0, 117)}…` : clean,
    summary: clean,
    keywords: [
      ...clean.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1).slice(0, 20),
      ...(stamp ? [stamp.slice(0, 10), stamp.slice(0, 7)] : []), // full date + YYYY-MM
    ],
    sourcePath: null,
    revision: computeRevision(clean),
    supersededBy: null,
  };
  store.upsert(item);
  // Keep the vector lane warm for semantic probes.
  void store.embedBackfill({ batchSize: 8 }).catch(() => {});
  return { ok: true, anchor };
}

function handle(req) {
  switch (req.op) {
    case 'reset':
      store.wipe();
      return { ok: true };
    case 'observe':
      return observe(req);
    case 'search': {
      const { items } = store.search({
        query: String(req.query ?? ''),
        limit: Math.min(20, Math.max(1, req.limit ?? 5)),
      });
      const detailed = store.db
        .prepare('SELECT anchor, updated_at FROM evidence_docs')
        .all();
      const updatedBy = Object.fromEntries(detailed.map((r) => [r.anchor, r.updated_at]));
      return {
        ok: true,
        results: items.map((i) => ({
          anchor: i.anchor,
          title: i.title,
          summary: i.summary,
          kind: i.kind,
          updatedAt: updatedBy[i.anchor] ?? null,
        })),
      };
    }
    case 'remove': {
      const anchors = Array.isArray(req.anchors) ? req.anchors : [];
      let removed = 0;
      for (const anchor of anchors) {
        if (store.getByAnchor(anchor)) {
          store.removeByAnchor(anchor);
          removed += 1;
        }
      }
      return { ok: true, removed };
    }
    case 'event': {
      const result = events.mark({
        title: String(req.title ?? ''),
        kind: 'observation',
        detail: req.detail ?? null,
        occurredAt: String(req.occurredAt ?? new Date().toISOString()),
        sourceKey: req.sourceKey ?? null,
      });
      return { ok: true, inserted: result.inserted, suppressed: result.suppressed === true };
    }
    case 'eventSearch': {
      const found = events.search({
        query: req.query,
        limit: Math.min(20, Math.max(1, req.limit ?? 5)),
      });
      return { ok: true, events: found };
    }
    case 'put': {
      // Direct evidence write for consolidated inferences (adapter-driven).
      const clean = String(req.text ?? '').trim();
      if (clean.length === 0) return { ok: true, skipped: true };
      const anchor = String(req.anchor ?? `infer-${Date.now()}`);
      store.upsert({
        anchor,
        kind: 'inference',
        status: 'active',
        authority: 'standard',
        title: clean.length > 120 ? `${clean.slice(0, 117)}…` : clean,
        summary: clean,
        keywords: Array.isArray(req.keywords) ? req.keywords : [],
        sourcePath: null,
        revision: computeRevision(clean),
        supersededBy: null,
      });
      void store.embedBackfill({ batchSize: 8 }).catch(() => {});
      return { ok: true, anchor };
    }
    case 'list': {
      const rows = store.db
        .prepare('SELECT anchor, kind, title, summary, keywords FROM evidence_docs ORDER BY anchor')
        .all();
      return { ok: true, items: rows.map((r) => ({ ...r, keywords: r.keywords ? r.keywords.split(',') : [] })) };
    }
    case 'stats':
      return { ok: true, evidence: store.stats(), events: events.stats() };
    default:
      return { ok: false, error: `unknown op: ${req.op}` };
  }
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const trimmed = line.trim();
  if (trimmed.length === 0) continue;
  let req;
  let response;
  try {
    req = JSON.parse(trimmed);
    response = handle(req);
  } catch (error) {
    response = { ok: false, error: error.message };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
