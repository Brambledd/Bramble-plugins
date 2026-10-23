// capture-service.js — automatic memory extraction (pure logic, no I/O
// beyond the EvidenceStore). The conversation buffer, LLM call, and Cordis
// wiring live in index.js; everything here is unit-testable.
//
// Design mirrors the Bemula-validated consolidation pass: LLM extraction of
// durable facts, dedup against the existing store, secret redaction (reused
// from lessons), and budget caps. Captured facts land as kind:'note' raw
// material — never as lessons (governance stays human-approved).

import { redactSecrets } from '../../lessons/src/redactor.js';

/** Extract STRICT-JSON facts array from an LLM answer, tolerantly. */
export function parseFacts(answer, maxFacts) {
  if (typeof answer !== 'string' || answer.length === 0) return [];
  let data = null;
  try {
    data = JSON.parse(answer);
  } catch {
    const start = answer.indexOf('{');
    const end = answer.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(answer.slice(start, end + 1));
      } catch {
        data = null;
      }
    }
  }
  const raw = Array.isArray(data?.facts) ? data.facts : [];
  const seen = new Set();
  const facts = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const fact = item.trim();
    if (fact.length < 8 || fact.length > 240) continue;
    const key = fact.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
    if (facts.length >= maxFacts) break;
  }
  return facts;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'their', 'there',
  'have', 'has', 'had', 'are', 'was', 'were', 'been', 'its', 'his', 'her',
  'they', 'them', 'you', 'your', 'our', 'not', 'but', 'all', 'any',
]);

/** Lexical overlap ≥ half the fact's distinct content words found in the entry. */
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

/** True when the store already contains a near-duplicate of the fact. */
export function isDuplicate(store, fact) {
  let items = [];
  try {
    ({ items } = store.search({ query: fact, limit: 3, includeInactive: true }));
  } catch {
    return false;
  }
  for (const item of items ?? []) {
    if (overlapsEntry(fact, item)) return true;
  }
  return false;
}

/** Count facts captured today (UTC) — the daily budget meter. */
export function todayCapturedCount(store, now = new Date()) {
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  try {
    const row = store.db
      .prepare("SELECT COUNT(*) AS n FROM evidence_docs WHERE anchor LIKE 'cap-%' AND updated_at >= ?")
      .get(dayStart);
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Run one capture pass over buffered turn texts.
 * @param {EvidenceStore} store
 * @param {() => Promise<string>} callLlm - resolves the assembled answer text
 * @param {Object} options
 * @param {string[]} options.turnTexts - buffered user-turn texts (oldest first)
 * @param {number} options.maxFacts
 * @param {boolean} options.redact
 * @returns {Promise<{written:number, skipped:number, facts:string[], redactions:number}>}
 */
export async function runCapturePass(store, callLlm, { turnTexts, maxFacts, redact }) {
  const answer = await callLlm();
  let facts = parseFacts(answer, maxFacts);
  let redactions = 0;
  if (redact) {
    facts = facts.map((f) => {
      const r = redactSecrets(f);
      redactions += r.redactions;
      return r.text;
    });
  }
  const seen = new Set();
  let written = 0;
  let skipped = 0;
  const kept = [];
  const ts = Date.now();
  for (const fact of facts) {
    const key = fact.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key) || isDuplicate(store, fact)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const anchor = `cap-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    store.upsert({
      anchor,
      kind: 'note',
      status: 'active',
      authority: 'standard',
      title: fact.slice(0, 120),
      summary: fact,
      keywords: fact.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1).slice(0, 20),
      sourcePath: null,
      revision: null,
      supersededBy: null,
    });
    kept.push(fact);
    written += 1;
  }
  return { written, skipped, facts: kept, redactions };
}

/** Build the extraction system prompt. */
export function captureSystemPrompt(maxFacts) {
  return (
    'You are a memory curator for a personal assistant. From the conversation ' +
    'segment, extract durable facts worth remembering across sessions: ' +
    'preferences, decisions, project state, corrections, commitments, people, ' +
    'schedules. Exclude ephemeral small talk, transient emotions, and anything ' +
    'already covered by the known entries. Write each fact as ONE self-contained ' +
    "third-person statement (at most 200 characters) naming the user (e.g. " +
    "'The user is migrating their blog from WordPress to Astro'). " +
    `Output STRICT JSON only: {"facts": ["..."]} — at most ${maxFacts} facts; ` +
    'empty array when nothing durable appears.'
  );
}

/** Build the user-turn prompt with dedup reference and the buffered turns. */
export function captureUserPrompt(knownSummaries, turnTexts) {
  const known = knownSummaries.length > 0
    ? `Known memory entries (do not repeat them):\n${knownSummaries.map((s) => `- ${s}`).join('\n')}\n\n`
    : '';
  const turns = turnTexts.map((t, i) => `【turn ${i + 1}】${t}`).join('\n');
  return `${known}Conversation segment:\n${turns}`;
}
