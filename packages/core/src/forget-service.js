// forget-service.js — structured targeted unlearning for the evidence store.
//
// Ported from the Bemula benchmark adapter (0.469 score) into product JS.
// The DSH agent (which IS an LLM) parses the user's natural-language forget
// request into structured parameters and calls this service; no separate
// LLM call is needed inside the plugin.
//
// Capabilities (all verified in Bemula lite5l):
// - scope routing: facts (multi-probe retrieval) / topic (store scan) /
//   timerange (deterministic date filtering via keyword tokens)
// - fresh-write guard: entries written in the last 10 minutes (relearning
//   values, F6 replacements) are never deletion candidates
// - residual verification loop: after deletion, re-probe with the original
//   targets; anything still matching is a residual and gets removed (max 2
//   rounds)
// - F6 replacement: after deleting the old value, observe the new one
// - soft delete for file-sourced entries: rewrite the .md frontmatter to
//   status:deleted so rescans skip it (file preserved for audit/recovery)
// - anti-resurrection: withdrawn inference summaries recorded so later
//   consolidation passes do not re-derive them

import { readFile, writeFile } from 'node:fs/promises';

const FRESH_WRITE_GUARD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Check if an entry is a fresh write (within the guard window).
 * Only guards dynamically-written entries (no sourcePath) — file-sourced
 * entries are established knowledge that happens to get a fresh updatedAt
 * on every rescan, and must remain deletable.
 */
/**
 * Fresh-write check. Default (no freshAfter): wall-clock window — protects
 * dynamically-written entries from the last 10 minutes (live product usage).
 * With freshAfter (replay/back-fill ingestion, e.g. benchmarks): an entry is
 * fresh when its dialogue timestamp is at/after the watermark — i.e. it was
 * observed AFTER the forget point. Replay writes carry their DIALOGUE
 * timestamps (bridge observe/put), so the watermark compares like with like.
 */
function isFreshWrite(entry, now = Date.now(), freshAfter = null) {
  if (entry.sourcePath) return false; // file-sourced = established knowledge
  if (!entry.updatedAt) return false;
  const t = Date.parse(entry.updatedAt);
  if (!Number.isFinite(t)) return false;
  if (freshAfter) {
    const fa = Date.parse(freshAfter);
    return Number.isFinite(fa) && t >= fa;
  }
  return now - t < FRESH_WRITE_GUARD_MS;
}

/** Extract date tokens (YYYY-MM-DD) from keywords for timerange filtering. */
function extractDateToken(keywords) {
  if (!Array.isArray(keywords)) return null;
  const dates = keywords.filter((k) => typeof k === 'string' && k.length === 10 && k[4] === '-' && k[7] === '-');
  return dates.length > 0 ? dates.sort()[0] : null;
}

/**
 * Timerange candidates: deterministic date-token filtering; when the corpus
 * carries no date tokens (e.g. dialogue turns without timestamps), fall back
 * to probe matching so the F5 request still lands (mirrors the Python
 * topic_filter fallback that kept F5 alive in lite5l).
 */
function timerangeCandidates(store, since, until, targets) {
  const byDate = timerangeFilter(store, since, until);
  if (byDate.length > 0) return byDate;
  return multiProbeSearch(store, targets).filter((e) => e.kind !== 'retraction');
}

/**
 * Execute a structured forget request against the evidence store.
 *
 * @param {EvidenceStore} store - the shared evidence store
 * @param {Object} options
 * @param {string} options.scope - "facts" | "topic" | "timerange"
 * @param {string[]} options.targets - search phrases (facts/topic)
 * @param {string} [options.since] - ISO date lower bound (timerange)
 * @param {string} [options.until] - ISO date upper bound (timerange)
 * @param {string} [options.replacement] - new value text (F6)
 * @param {Function} [options.onSoftDelete] - callback(file, entry) for file deletion
 * @returns {Object} summary { removed, remaining, replacementWritten, details }
 */
export async function executeForget(store, options) {
  const { scope = 'facts', targets = [], since, until, replacement, onSoftDelete, freshAfter } = options;
  const now = Date.now();
  const sinceDate = typeof since === 'string' ? since.slice(0, 10) : undefined;
  const untilDate = typeof until === 'string' ? until.slice(0, 10) : undefined;

  // Phase 1: locate candidates
  let candidates = [];
  if (scope === 'timerange') {
    candidates = timerangeCandidates(store, sinceDate, untilDate, targets);
  } else if (scope === 'topic') {
    candidates = topicScan(store, targets);
  } else {
    candidates = multiProbeSearch(store, targets);
  }

  // Phase 1b: topical gate — OR-matching probes recall broadly (any shared
  // word matches), so candidates are validated against the request's own
  // content words before deletion. Scope-aware: facts/timerange demand that
  // most of the request's words appear in the entry (a mixed note carrying
  // unrelated facts falls below the bar and survives); topic scope stays
  // recall-first because its residue is denied at answer time by the
  // retraction marker.
  candidates = topicalGateFilter(candidates, targets, scope);

  // Phase 2: fresh-write guard
  const removable = candidates.filter((e) => !isFreshWrite(e, now, freshAfter));
  const protectedCount = candidates.length - removable.length;

  // Phase 3: execute deletion (capturing summaries BEFORE removal — the
  // store rows are gone after removeEntry, but the forgotten-content seed
  // words for the derived sweep come from exactly these summaries)
  const details = [];
  const removedSummaries = [];
  for (const entry of removable) {
    if (entry.summary) removedSummaries.push(entry.summary);
    const result = await removeEntry(store, entry, onSoftDelete);
    details.push(result);
  }

  // Phase 4: residual verification (max 2 rounds)
  let residualRemoved = 0;
  for (let round = 0; round < 2; round += 1) {
    const residuals = findResiduals(store, targets, scope, sinceDate, untilDate, now, freshAfter);
    if (residuals.length === 0) break;
    for (const entry of residuals) {
      if (entry.summary) removedSummaries.push(entry.summary);
      await removeEntry(store, entry, onSoftDelete);
      residualRemoved += 1;
      details.push({ anchor: entry.anchor, method: 'residual' });
    }
  }

  // Phase 4c: timerange ack-capture — the assistant's own confirmation
  // ("I've forgotten the December events including the Penang trip") is
  // timestamped after the window, so the date filter spares it, yet it
  // re-introduces the forgotten topic words into every later answer. Probe
  // passes with NO date filter remove any entry matching the request's own
  // wording (ported from clowder-ai 5c68d6f6). Runs BEFORE the derived
  // sweep so captured wording also seeds the sweep.
  if (scope === 'timerange') {
    for (let round = 0; round < 2; round += 1) {
      const acks = topicalGateFilter(multiProbeSearch(store, targets), targets, scope).filter((e) => {
        if (isFreshWrite(e, now, freshAfter)) return false;
        if (e.kind === 'retraction') return false;
        return true;
      });
      if (acks.length === 0) break;
      for (const entry of acks) {
        if (details.some((d) => d.anchor === entry.anchor)) continue;
        if (entry.summary) removedSummaries.push(entry.summary);
        await removeEntry(store, entry, onSoftDelete);
        details.push({ anchor: entry.anchor, method: 'ack-capture' });
        residualRemoved += 1;
      }
    }
  }

  // Phase 4b: derived-representation sweep (ported from clowder-ai
  // feat/targeted-unlearning). Consolidated/observed notes written BEFORE
  // the forget can restate the forgotten facts. A note is deleted ONLY when
  // its own substantive content words are (nearly) fully covered by the
  // forgotten-content seed words — a note mixing forgotten and preserved
  // facts stays (conservative; partial residue beats collateral damage).
  // Seed = summaries of what was actually removed (fallback: the request's
  // own target words). Retraction markers and file-sourced docs are never
  // swept here — markers ARE the forget's answer-time enforcement.
  const seedWords = new Set();
  for (const summary of removedSummaries) {
    for (const w of contentWords(summary)) seedWords.add(w);
  }
  if (seedWords.size === 0) {
    for (const t of targets) for (const w of contentWords(t)) seedWords.add(w);
  }
  if (seedWords.size > 0) {
    const swept = sweepDerivedNotes(store, seedWords, now, freshAfter);
    for (const anchor of swept) {
      details.push({ anchor, method: 'derived-sweep' });
      residualRemoved += 1;
    }
  }

  // Phase 5: F6 replacement
  let replacementWritten = false;
  let replacementAnchor = null;
  if (replacement && typeof replacement === 'string' && replacement.trim().length > 0) {
    replacementAnchor = `repl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    store.upsert({
      anchor: replacementAnchor,
      kind: 'note',
      status: 'active',
      authority: 'standard',
      title: replacement.trim().slice(0, 120),
      summary: replacement.trim(),
      keywords: replacement.trim().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1).slice(0, 20),
      sourcePath: null,
      revision: null,
      supersededBy: null,
    });
    // The replacement is a positive new value: any active retraction marker
    // on this topic would contradict it at answer time — supersede it
    // (clowder-ai 221c9d1c: F6 writes the positive value, not a deny-list).
    const replacementTopics = [...new Set(targets.flatMap((t) => contentWords(t)))];
    const staleMarker = replacementTopics.length > 0 ? findActiveRetraction(store, replacementTopics) : null;
    if (staleMarker) store.supersede(staleMarker.anchor, replacementAnchor);
    replacementWritten = true;
  }

  // Phase 6: retraction marker (ported from clowder-ai e4e2f57b + 221c9d1c).
  // Epistemic erasure, NEVER negation: the marker carries TOPIC WORDS only
  // (from the request's own wording — never the suppressed fact text, which
  // would re-leak it) and moves the topic to UNKNOWN as of forgottenAt.
  // forgottenAt uses the DIALOGUE-time forget point (freshAfter) when the
  // host provides one — replayed corpora carry dialogue timestamps, and the
  // supersession clause ("a statement updated AFTER forgottenAt wins") must
  // compare like with like or relearning can never win. Live usage (no
  // freshAfter) falls back to wall clock. Written for EVERY non-replacement
  // forget — including removed=0: a forget that matched nothing is exactly
  // the variant-wording case where the answer-time deny-list matters most.
  if (!replacementWritten) {
    // Marker footprint = request wording ∪ removed entries' content words.
    // Relearning usually reuses the DOMAIN vocabulary of the forgotten facts
    // ("joined a walking group" after deleting "library book group"), not
    // the request's phrasing — the expanded keyword set is what lets the
    // any-overlap supersession rule recognize it. Single words carry no
    // fact restatement, so the no-re-leak rule still holds.
    const topicWords = [
      ...new Set([...targets.flatMap((t) => contentWords(t)), ...removedSummaries.flatMap((s) => contentWords(s))]),
    ].slice(0, 30);
    if (topicWords.length > 0) {
      const existing = findActiveRetraction(store, targets.flatMap((t) => contentWords(t)));
      const forgottenAt = freshAfter
        ? new Date(Date.parse(freshAfter) || Date.now()).toISOString()
        : new Date().toISOString();
      if (existing) {
        // Same topic forgotten again: refresh forgottenAt + widen the
        // keyword footprint on the live marker instead of stacking.
        const refreshed = {
          ...existing,
          keywords: topicWords,
          summary: retractionSummary(topicWords, forgottenAt),
          updatedAt: forgottenAt,
        };
        store.upsert(refreshed);
      } else {
        store.upsert({
          anchor: `retract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'retraction',
          status: 'active',
          // constitutional: never demoted by recency ranking — a forgotten
          // topic's deny-list must not fade with disuse.
          authority: 'constitutional',
          title: `Forgotten topic: ${topicWords.slice(0, 8).join(', ')}`,
          summary: retractionSummary(topicWords, forgottenAt),
          keywords: topicWords,
          sourcePath: null,
          revision: null,
          supersededBy: null,
          updatedAt: forgottenAt,
        });
      }
    }
  }

  return {
    removed: removable.length + residualRemoved,
    protected: protectedCount,
    remaining: countRemaining(store, targets, scope, since, until),
    replacementWritten,
    replacementAnchor,
    retractionMarker: !replacementWritten && targets.some((t) => contentWords(t).length > 0),
    details,
  };
}

/** The answer-time policy text carried by every retraction marker. */
function retractionSummary(topicWords, forgottenAt) {
  return (
    `Retraction marker (forgottenAt: ${forgottenAt}). Topics retracted at the ` +
    `user's request (${topicWords.slice(0, 8).join(', ')}) are UNKNOWN as of this ` +
    'timestamp. Answer policy: refuse without confirming, denying, or ' +
    'mentioning them — UNLESS the context contains a statement about these ' +
    'topics updated AFTER forgottenAt, which supersedes this marker.'
  );
}

/**
 * Ingest-side supersession (clowder-ai 221c9d1c): when a NEW fact lands
 * about a topic covered by an ACTIVE retraction marker, flip the marker to
 * superseded — post-forget relearning overrides the answer-time refusal.
 * Deterministic kind listing (ranked search can hide markers behind
 * stronger-matching docs). Exported for the plugin tool and the bridge.
 */
export function supersedeRetractionsForText(store, text, newAnchor) {
  const words = [
    ...new Set(
      String(text)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2 && !SWEEP_STOPWORDS.has(w)),
    ),
  ];
  if (words.length === 0) return 0;
  let superseded = 0;
  try {
    const rows = store.db
      .prepare("SELECT anchor, keywords FROM evidence_docs WHERE kind = 'retraction' AND status = 'active'")
      .all();
    const textWords = new Set(words);
    for (const row of rows) {
      const markerWords = (row.keywords ?? '')
        .split(',')
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length > 2);
      const overlap = markerWords.filter((w) => textWords.has(w)).length;
      // ANY-overlap rule: markers block a WHOLE topic, so the costs are
      // asymmetric — a false-positive supersede just lifts the refusal for
      // a genuinely new statement (mild), while a false-negative blocks
      // relearning outright (RLA hard fail). Variant wording ("joined a
      // walking group" vs a "social life" marker) shares domain words, not
      // request words — one hit is enough to count as topical.
      if (overlap >= 1) {
        store.supersede(row.anchor, newAnchor);
        superseded += 1;
      }
    }
  } catch {
    // supersession is best-effort
  }
  return superseded;
}

/** Find an active retraction marker whose topic words overlap the targets.
 *  Candidates come from a deterministic kind listing — NOT ranked search:
 *  a stronger-matching doc can short-circuit progressive FTS and hide the
 *  marker (verified: an AND-matching note hid the marker from the OR tier). */
function findActiveRetraction(store, topicWords) {
  let rows = [];
  try {
    rows = store.db
      .prepare("SELECT anchor, keywords FROM evidence_docs WHERE kind = 'retraction' AND status = 'active'")
      .all();
  } catch {
    return null;
  }
  const targets = new Set(topicWords.map((w) => w.toLowerCase()));
  for (const row of rows) {
    const markerWords = (row.keywords ?? '')
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 2);
    const overlap = markerWords.filter((w) => targets.has(w)).length;
    if (overlap >= Math.max(1, Math.ceil(Math.min(markerWords.length, topicWords.length) / 2))) {
      return store.getByAnchor(row.anchor);
    }
  }
  return null;
}

/** Content words of a text: distinct, lowercase, stopword-filtered. */
const SWEEP_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'their', 'there',
  'have', 'has', 'had', 'are', 'was', 'were', 'been', 'its', 'his', 'her',
  'they', 'them', 'you', 'your', 'our', 'not', 'but', 'all', 'any', 'user',
  'prefers', 'note',
]);
function contentWords(text) {
  return [
    ...new Set(
      String(text)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2 && !SWEEP_STOPWORDS.has(w)),
    ),
  ];
}

const DERIVED_DOC_COVERAGE_THRESHOLD = 0.35;

/**
 * Topical gate for probe candidates. Direction matters: ratio = how much of
 * the REQUEST's content words the entry covers (not the reverse — coverage
 * of the entry punishes information-rich docs that are legitimately about
 * the topic). Scope-aware precision:
 *   facts/timerange (F1/F6/F5): >=60% of the request words must appear —
 *     these are precise asks; a mixed note carrying unrelated facts must
 *     survive.
 *   topic (F3): no extra gate — the request IS broad, OR-recall is the
 *     intent, and residue is denied at answer time by the retraction marker.
 */
function topicalGateFilter(candidates, targets, scope) {
  const seedWords = new Set();
  for (const t of targets) for (const w of contentWords(t)) seedWords.add(w);
  if (seedWords.size === 0) return candidates;
  if (scope === 'topic') return candidates;
  const seed = [...seedWords];
  return candidates.filter((entry) => {
    const hay = `${entry.title ?? ''} ${entry.summary ?? ''}`.toLowerCase();
    let hits = 0;
    for (const w of seed) if (hay.includes(w)) hits += 1;
    return hits / seed.length >= 0.6;
  });
}

/** Topical gate shared by the derived sweep: the entry's substantive words
 *  (summary) must be sufficiently covered by the forgotten-topic seed. */
function passesTopicalGate(entry, seedWords, threshold = DERIVED_DOC_COVERAGE_THRESHOLD) {
  const hay = `${entry.title ?? ''} ${entry.summary ?? ''}`;
  const docWords = contentWords(hay);
  if (docWords.length === 0) return false;
  const covered = docWords.filter((w) => seedWords.has(w)).length;
  return covered / docWords.length >= threshold;
}

/**
 * Delete dynamically-written notes whose substantive content is (nearly)
 * fully covered by the forgotten-content seed words. Conservative: notes
 * mixing forgotten and preserved facts stay. Skips retraction markers,
 * fresh writes (relearning values observed after the forget point), and
 * file-sourced docs (the latter retire via removeEntry's soft delete only).
 */
function sweepDerivedNotes(store, seedWords, now = Date.now(), freshAfter = null) {
  const swept = [];
  try {
    const rows = store.db
      .prepare(
        "SELECT anchor FROM evidence_docs WHERE source_path IS NULL AND kind != 'retraction'",
      )
      .all();
    for (const row of rows) {
      const entry = store.getByAnchor(row.anchor);
      if (!entry || entry.status !== 'active') continue;
      if (isFreshWrite(entry, now, freshAfter)) continue;
      if (!entry.summary || entry.summary.length < 20) continue;
      const docWords = contentWords(entry.summary);
      if (docWords.length === 0) continue;
      const covered = docWords.filter((w) => seedWords.has(w)).length;
      if (covered / docWords.length >= DERIVED_DOC_COVERAGE_THRESHOLD) {
        store.removeByAnchor(entry.anchor);
        swept.push(entry.anchor);
      }
    }
  } catch {
    // listing unavailable — skip the sweep silently
  }
  return swept;
}

// ---------------------------------------------------------- helper functions

/**
 * Multi-probe retrieval: for each target phrase, search with the full phrase
 * plus keyword-decomposition sub-probes (first-2 and last-2 content words).
 * Mirrors the E2 strategy validated in Bemula.
 */
function multiProbeSearch(store, targets) {
  const seen = new Set();
  const results = [];
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'my', 'me', 'i', 'you', 'your', 'that', 'this',
    'of', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'were', 'in', 'on',
    'about', 'from', 'with', 'please', 'kindly', 'just', 'now', 'also',
    'fact', 'facts', 'information', 'memory', 'record', 'records',
  ]);
  for (const target of targets) {
    const probes = [target];
    const words = target
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));
    if (words.length >= 2) probes.push(words.slice(0, 2).join(' '));
    if (words.length > 2) probes.push(words.slice(-2).join(' '));
    for (const probe of probes) {
      const { items } = store.search({ query: probe, limit: 10, includeInactive: true });
      for (const item of items) {
        if (!seen.has(item.anchor)) {
          seen.add(item.anchor);
          results.push(item);
        }
      }
    }
  }
  return results;
}

/**
 * Topic scan: search with each target phrase and collect all matches.
 * For topics, includeInactive=true to catch entries that might have been
 * demoted but still match the topic.
 */
function topicScan(store, targets) {
  const seen = new Set();
  const results = [];
  for (const target of targets) {
    const { items } = store.search({ query: target, limit: 20, includeInactive: true });
    for (const item of items) {
      if (!seen.has(item.anchor)) {
        seen.add(item.anchor);
        results.push(item);
      }
    }
  }
  return results;
}

/**
 * Deterministic timerange filter via keyword date tokens.
 * Mirrors the F5 path validated in Bemula.
 */
function timerangeFilter(store, since, until) {
  if (!since && !until) return [];
  const rows = store.db
    .prepare('SELECT anchor, keywords, source_path FROM evidence_docs')
    .all();
  const results = [];
  for (const row of rows) {
    const keywords = row.keywords ? row.keywords.split(',').map((s) => s.trim()) : [];
    const dateToken = extractDateToken(keywords);
    if (!dateToken) continue;
    if (since && dateToken < since) continue;
    if (until && dateToken > until) continue;
    const item = store.getByAnchor(row.anchor);
    if (item) results.push(item);
  }
  return results;
}

/**
 * Remove one entry: index row + optional soft-delete of the source file.
 * Returns { anchor, method: 'index' | 'file' | 'both' }.
 */
async function removeEntry(store, entry, onSoftDelete) {
  const anchor = entry.anchor;
  let method = 'index';

  // Anti-resurrection guard: record withdrawn inference summaries
  if (entry.kind === 'inference' && entry.summary) {
    store.recordCueConsumption({
      owner: 'system',
      family: 'suppressed-inference',
      sourceAnchor: anchor,
      sourceRevision: entry.revision ?? '',
      terminal: 'withdrawn',
    });
  }

  // Soft-delete file-sourced entries (rewrite frontmatter status).
  // Tolerates a leading BOM (files created via PowerShell UTF8 have one).
  if (entry.sourcePath) {
    try {
      const content = (await readFile(entry.sourcePath, 'utf8')).replace(/^\uFEFF/, '');
      const updated = content.replace(
        /^---\r?\n([\s\S]*?)\r?\n---/,
        (match, fm) => {
          if (/^status:\s*/m.test(fm)) {
            return `---\n${fm.replace(/^status:\s*.*$/m, 'status: deleted')}\n---`;
          }
          return `---\n${fm}\nstatus: deleted\n---`;
        },
      );
      if (updated !== content) {
        await writeFile(entry.sourcePath, updated, 'utf8');
        method = 'file';
      }
    } catch {
      // File might not exist or might not be accessible; index-only removal
    }
    if (onSoftDelete) {
      onSoftDelete(entry.sourcePath, entry);
    }
  }

  store.removeByAnchor(anchor);
  if (method === 'file') method = 'both';
  return { anchor, method };
}

/**
 * Residual scan: after deletion, re-probe with the original targets.
 * Returns entries that still pass the topical gate and are not fresh writes.
 */
function findResiduals(store, targets, scope, since, until, now, freshAfter) {
  let candidates;
  if (scope === 'timerange') {
    candidates = timerangeCandidates(store, since, until, targets);
  } else {
    candidates = multiProbeSearch(store, targets);
  }
  candidates = topicalGateFilter(candidates, targets, scope);
  return candidates.filter((e) => !isFreshWrite(e, now, freshAfter) && e.kind !== 'retraction');
}

/** Count remaining matching entries (for the summary report). */
function countRemaining(store, targets, scope, since, until) {
  if (scope === 'timerange') {
    return topicalGateFilter(timerangeCandidates(store, since, until, targets), targets, scope).length;
  }
  const seen = new Set();
  for (const target of targets) {
    const { items } = store.search({ query: target, limit: 20 });
    for (const item of items) seen.add(item.anchor);
  }
  const candidates = [...seen].map((anchor) => store.getByAnchor(anchor)).filter(Boolean);
  return topicalGateFilter(candidates, targets, scope).length;
}
