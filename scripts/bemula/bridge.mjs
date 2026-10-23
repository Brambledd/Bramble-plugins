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
import { executeForget, supersedeRetractionsForText } from '../../packages/core/src/forget-service.js';

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
    // Truthful dialogue provenance: the fresh-write watermark compares
    // dialogue time against the forget point (freshAfter), not wall clock.
    updatedAt: stamp || undefined,
  };
  store.upsert(item);
  // Keep the vector lane warm for semantic probes.
  void store.embedBackfill({ batchSize: 8 }).catch(() => {});
  return { ok: true, anchor };
}

async function handle(req) {
  switch (req.op) {
    case 'reset':
      store.wipe();
      return { ok: true };
    case 'forget':
      // Product forget pipeline (0.4.x): scope-routed deletion + fresh guard
      // + residual loop + derived sweep + timerange ack-capture + retraction
      // marker + F6 replacement. The Python adapter plans; this executes.
      // freshAfter = dialogue timestamp of the forget turn: replay-safe
      // fresh-write watermark (entries observed after this point are
      // relearning values and stay protected).
      console.error(`[bridge:forget] scope=${req.scope} targets=${JSON.stringify(req.targets)} since=${req.since} until=${req.until} freshAfter=${req.freshAfter}`);
      {
        const result = await executeForget(store, {
          scope: req.scope,
          targets: Array.isArray(req.targets) ? req.targets.map(String) : [],
          since: req.since,
          until: req.until,
          replacement: req.replacement,
          freshAfter: req.freshAfter || null,
        });
        console.error(`[bridge:forget] removed=${result.removed} protected=${result.protected} remaining=${result.remaining} replacement=${result.replacementWritten}`);
        return result;
      }
    case 'observe':
      return observe(req);
    case 'search': {
      const { items } = store.search({
        query: String(req.query ?? ''),
        limit: Math.min(20, Math.max(1, req.limit ?? 5)),
        // Replay corpus: entries carry DIALOGUE timestamps, so wall-clock
        // recency decay is meaningless here and sinks early-session facts
        // out of top-k (RA collapse in lite6a). Live product keeps decay.
        recencyDecay: false,
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
    case 'supersedeMarkers': {
      // Ingest-side supersession: a newly observed turn restating a
      // forgotten topic flips the marker (relearning overrides refusal).
      const superseded = supersedeRetractionsForText(
        store,
        String(req.text ?? ''),
        String(req.anchor ?? ''),
      );
      return { ok: true, superseded };
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
      const stamp = String(req.timestamp ?? '').trim();
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
        // Dialogue-time provenance for the fresh-write watermark
        updatedAt: stamp || undefined,
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
    response = await handle(req);
  } catch (error) {
    response = { ok: false, error: error.message };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
