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
function isFreshWrite(entry, now = Date.now()) {
  if (entry.sourcePath) return false; // file-sourced = established knowledge
  if (!entry.updatedAt) return false;
  const t = Date.parse(entry.updatedAt);
  if (!Number.isFinite(t)) return false;
  return now - t < FRESH_WRITE_GUARD_MS;
}

/** Extract date tokens (YYYY-MM-DD) from keywords for timerange filtering. */
function extractDateToken(keywords) {
  if (!Array.isArray(keywords)) return null;
  const dates = keywords.filter((k) => typeof k === 'string' && k.length === 10 && k[4] === '-' && k[7] === '-');
  return dates.length > 0 ? dates.sort()[0] : null;
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
  const { scope = 'facts', targets = [], since, until, replacement, onSoftDelete } = options;
  const now = Date.now();

  // Phase 1: locate candidates
  let candidates = [];
  if (scope === 'timerange') {
    candidates = timerangeFilter(store, since, until);
  } else if (scope === 'topic') {
    candidates = topicScan(store, targets);
  } else {
    candidates = multiProbeSearch(store, targets);
  }

  // Phase 2: fresh-write guard
  const removable = candidates.filter((e) => !isFreshWrite(e, now));
  const protectedCount = candidates.length - removable.length;

  // Phase 3: execute deletion
  const details = [];
  for (const entry of removable) {
    const result = await removeEntry(store, entry, onSoftDelete);
    details.push(result);
  }

  // Phase 4: residual verification (max 2 rounds)
  let residualRemoved = 0;
  for (let round = 0; round < 2; round += 1) {
    const residuals = findResiduals(store, targets, scope, since, until, now);
    if (residuals.length === 0) break;
    for (const entry of residuals) {
      await removeEntry(store, entry, onSoftDelete);
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
    replacementWritten = true;
  }

  return {
    removed: removable.length + residualRemoved,
    protected: protectedCount,
    remaining: countRemaining(store, targets, scope, since, until),
    replacementWritten,
    replacementAnchor,
    details,
  };
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

  // Soft-delete file-sourced entries (rewrite frontmatter status)
  if (entry.sourcePath) {
    try {
      const content = await readFile(entry.sourcePath, 'utf8');
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
 * Returns entries that still match and are not fresh writes.
 */
function findResiduals(store, targets, scope, since, until, now) {
  let candidates;
  if (scope === 'timerange') {
    candidates = timerangeFilter(store, since, until);
  } else {
    candidates = multiProbeSearch(store, targets);
  }
  return candidates.filter((e) => !isFreshWrite(e, now));
}

/** Count remaining matching entries (for the summary report). */
function countRemaining(store, targets, scope, since, until) {
  if (scope === 'timerange') {
    return timerangeFilter(store, since, until).length;
  }
  const seen = new Set();
  for (const target of targets) {
    const { items } = store.search({ query: target, limit: 20 });
    for (const item of items) seen.add(item.anchor);
  }
  return seen.size;
}
