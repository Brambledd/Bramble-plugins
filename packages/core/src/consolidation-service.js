// consolidation-service.js — Condensation: the sixth memory atomic op
// (survey 2505.00675: Consolidation/Updating/Indexing/Forgetting/Retrieval/
// Condensation). Bramble had all but this one.
//
// Two bounded, conservative phases over ACTIVE DYNAMIC notes only
// (source_path IS NULL, kind='note') — file-sourced truth is governed by
// soft delete, retraction markers are enforcement rows:
//
//   MERGE   — near-identical restatements that slipped past the ingest
//             top-3 window (older duplicates from before the unified
//             pipeline, cross-day restatements). Requires MUTUAL lexical
//             coverage >= 0.7 both directions, so complementary facts
//             survive; the NEWER statement wins (latest-wins, no LLM
//             synthesis) and the older row is superseded.
//   ARCHIVE — stale untouched trivia (importance 1, untouched for
//             archiveAfterDays) demoted to status 'archived': reversible,
//             demoted by search, skipped by cues and consolidation sweeps.
//             Deletion stays a user decision, never a background job.
//
// Coordination contracts honored here:
// - fresh writes (< freshWindowMs) are skipped — never fight the ingest
//   pipeline or the forget-service fresh-write guard;
// - archived rows are NOT deletable collateral: forget sweeps skip
//   non-active rows, so archive and forget stay orthogonal;
// - every phase is budget-capped per call (a hygiene pass, not a batch job).

const DEFAULTS = {
  maxMerges: 4,
  maxArchive: 10,
  archiveAfterDays: 180,
  freshWindowMs: 60 * 60 * 1000, // 1 hour — ingest owns this window
  scanCap: 200,
  mutualCoverage: 0.7,
};

function words(text) {
  return [
    ...new Set(
      String(text)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2),
    ),
  ];
}

/** Light plural normalization (editors→editor, terminals→terminal) so
 *  singular/plural drift between restatements does not defeat matching. */
function normalizeToken(w) {
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/**
 * Coverage = |a ∩ b| / |a| over normalized token SETS (substring matching
 * is too brittle across singular/plural drift between restatements).
 */
function coverage(aWords, bTokens) {
  if (aWords.length === 0) return 0;
  let hits = 0;
  for (const w of aWords) if (bTokens.has(normalizeToken(w))) hits += 1;
  return hits / aWords.length;
}

function tokenSet(text) {
  return new Set(words(text).map(normalizeToken));
}

/**
 * Run one bounded condensation pass.
 * @returns {{scanned: number, merged: {kept: string, superseded: string}[], archived: string[]}}
 */
export function consolidateNotes(store, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const now = Date.now();
  const rows = store.db
    .prepare(
      `SELECT anchor FROM evidence_docs
       WHERE source_path IS NULL AND kind = 'note' AND status = 'active'
         AND superseded_by IS NULL
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(opts.scanCap);

  const entries = [];
  for (const row of rows) {
    const item = store.getByAnchor(row.anchor);
    if (!item || !item.summary || item.summary.length < 20) continue;
    const age = now - (Date.parse(item.updatedAt) || now);
    if (age < opts.freshWindowMs) continue; // ingest owns fresh rows
    entries.push(item);
  }

  const merged = [];
  // ---- MERGE: newest-first greedy pairing (bounded) -----------------------
  outer: for (let i = 0; i < entries.length && merged.length < opts.maxMerges; i += 1) {
    const newer = entries[i];
    if (store.getByAnchor(newer.anchor)?.status !== 'active') continue;
    const newerTokens = tokenSet(`${newer.title ?? ''} ${newer.summary}`);
    const newerWords = words(newer.summary);
    for (let j = i + 1; j < entries.length; j += 1) {
      const older = entries[j];
      if (store.getByAnchor(older.anchor)?.status !== 'active') continue;
      const olderTokens = tokenSet(`${older.title ?? ''} ${older.summary}`);
      if (coverage(newerWords, olderTokens) < opts.mutualCoverage) continue;
      if (coverage(words(older.summary), newerTokens) < opts.mutualCoverage) continue;
      store.supersede(older.anchor, newer.anchor);
      merged.push({ kept: newer.anchor, superseded: older.anchor });
      continue outer; // newer consumed; next newer
    }
  }

  // ---- ARCHIVE: stale untouched importance-1 trivia (bounded) -------------
  const archived = [];
  if (opts.maxArchive > 0 && opts.archiveAfterDays > 0) {
    const staleCutoff = now - opts.archiveAfterDays * 86_400_000;
    for (const item of entries) {
      if (archived.length >= opts.maxArchive) break;
      // rows touched by THIS pass (either merge side) count as just-accessed
      if (merged.some((m) => m.kept === item.anchor || m.superseded === item.anchor)) continue;
      if ((item.importance ?? 1) > 1) continue; // rated value is never trivia
      const touched = Date.parse(item.lastAccessed ?? '') || Date.parse(item.updatedAt) || now;
      if (touched >= staleCutoff) continue;
      store.db
        .prepare("UPDATE evidence_docs SET status = 'archived' WHERE anchor = ?")
        .run(item.anchor);
      archived.push(item.anchor);
    }
  }

  return { scanned: entries.length, merged, archived };
}
