// ingest-service.js — unified memory write pipeline (single owner).
//
// Consolidates the two formerly-divergent write paths (memory_observe and
// dsh-memory-capture) into one deterministic pipeline, ported from Mem0's
// consolidation stage (mem0/memory/main.py add(): extract -> find similar ->
// ADD/UPDATE/DELETE/NOOP decision) with the LLM decision replaced by lexical
// overlap — the plugin never calls the LLM itself, the host agent already
// authored the statement.
//
// Fixed stage order (the coordination contract):
//   1. validate + normalize (keywords/tags/date-token)
//   2. NOOP check  — exact restatement of an existing note writes nothing
//   3. UPDATE check — variant restatement SUPERSEDES the old note (Mem0
//      UPDATE semantics) instead of accumulating duplicates that dilute RRF
//   4. upsert + link top matches (A-MEM dynamic linking)
//   5. retraction supersession — relearning overrides active markers
//      (forget-service helper; runs last because it needs the new anchor)
import { supersedeRetractionsForText } from './forget-service.js';
import { computeRevision } from './util.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'their', 'there',
  'have', 'has', 'had', 'are', 'was', 'were', 'been', 'its', 'his', 'her',
  'they', 'them', 'you', 'your', 'our', 'not', 'but', 'all', 'any',
]);

/**
 * Lexical overlap: >= half the fact's distinct content words appear in the
 * entry (moved here from capture-service so both write paths share ONE
 * dedup rule; capture-service re-exports it for compatibility).
 */
export function overlapsEntry(fact, entry) {
  const words = [
    ...new Set(
      fact
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    ),
  ];
  if (words.length === 0) return false;
  const hay = `${entry.title ?? ''} ${entry.summary ?? ''}`.toLowerCase();
  let hits = 0;
  for (const w of words) if (hay.includes(w)) hits += 1;
  return hits >= Math.max(1, Math.ceil(words.length / 2));
}

function normalizeText(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function isConsolidatable(entry) {
  return (
    entry &&
    entry.kind === 'note' &&
    entry.status === 'active' &&
    !entry.supersededBy &&
    !entry.sourcePath // dynamic rows only; file-sourced docs are governed by soft delete
  );
}

const SOURCE_PREFIX = { observe: 'obs', capture: 'cap' };

/**
 * Run the unified ingest pipeline for one statement.
 *
 * @returns {{anchor: string, decision: 'add'|'update'|'noop',
 *            supersededNote: string|null, supersededRetractions: number,
 *            linked: string[], error?: string}}
 */
export function ingestMemory(store, { text, tags = [], source = 'observe', date = null, importance = 1 }) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (clean.length < 4) {
    return { anchor: null, decision: 'noop', supersededNote: null, supersededRetractions: 0, linked: [], error: 'text must be a self-contained statement (min 4 chars)' };
  }

  // Stage 1: candidates from one search, shared by NOOP/UPDATE/link stages.
  let candidates = [];
  try {
    ({ items: candidates } = store.search({ query: clean, limit: 3, includeInactive: false }));
  } catch {
    candidates = [];
  }
  const consolidatable = candidates.filter(isConsolidatable);

  // Stage 2: NOOP — identical restatement.
  const normalized = normalizeText(clean);
  const identical = consolidatable.find((entry) => normalizeText(entry.summary ?? '') === normalized);
  if (identical) {
    store.touchAnchor(identical.anchor); // restatement is also retrieval practice
    return { anchor: identical.anchor, decision: 'noop', supersededNote: null, supersededRetractions: 0, linked: [] };
  }

  // Stage 3: UPDATE — variant restatement supersedes the closest old note.
  const stale = consolidatable.find((entry) => overlapsEntry(clean, entry)) ?? null;

  const prefix = SOURCE_PREFIX[source] ?? 'obs';
  const anchor = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const keywords = [
    ...clean.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1).slice(0, 20),
    ...(Array.isArray(tags) ? tags.map(String).slice(0, 10) : []),
  ];
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    keywords.push(date); // date token: feeds parseTemporalQuery + forget timerange
  }
  store.upsert({
    anchor,
    kind: 'note',
    status: 'active',
    authority: 'standard',
    title: clean.slice(0, 120),
    summary: clean,
    keywords,
    sourcePath: null,
    // Dynamic content is its own truth: hash it so the vector lane can stamp
    // and freshness-check embeddings (a NULL revision silently killed the
    // whole backfill lane — surfaced by the LongMemEval harness).
    revision: computeRevision(clean),
    supersededBy: null,
    importance, // LLM-rated 1-5 (Generative Agents third factor); clamped in the store
  });
  // Flip the superseded row AFTER the successor exists (supersede chain
  // points old -> new; the store demotes it and search sinks it).
  if (stale) store.supersede(stale.anchor, anchor);

  // Stage 4: link the new note to near matches (skip the superseded one —
  // dead entries must not stay wired into the graph — and retraction
  // markers, which are enforcement rows, not knowledge).
  const linked = [];
  for (const entry of candidates) {
    if (entry.anchor === anchor) continue;
    if (entry.kind === 'retraction') continue;
    if (stale && entry.anchor === stale.anchor) continue;
    store.putLink(anchor, entry.anchor, 0.6);
    linked.push(entry.anchor);
    if (linked.length >= 2) break;
  }

  // Stage 5: relearning overrides retraction markers (forget-service helper).
  const supersededRetractions = supersedeRetractionsForText(store, clean, anchor);

  return { anchor, decision: stale ? 'update' : 'add', supersededNote: stale?.anchor ?? null, supersededRetractions, linked };
}
