// capture-service.js — automatic memory extraction (pure logic, no I/O
// beyond the EvidenceStore). The conversation buffer, LLM call, and Cordis
// wiring live in index.js; everything here is unit-testable.
//
// Design mirrors the Bemula-validated consolidation pass: LLM extraction of
// durable facts, dedup against the existing store, secret redaction (reused
// from lessons), and budget caps. Captured facts land as kind:'note' raw
// material — never as lessons (governance stays human-approved).

import { redactSecrets } from '../../lessons/src/redactor.js';
import { ingestMemory, overlapsEntry } from '../../core/src/ingest-service.js';

// Shared dedup rule: overlapsEntry lives in the unified ingest pipeline so
// observe and capture can never drift apart. Re-exported for compatibility.
export { overlapsEntry };

/**
 * Extract structured fact objects from an LLM answer, tolerantly.
 * Accepts BOTH shapes (LongMemEval fact-augmentation fields):
 *   {"facts": ["plain string", ...]}
 *   {"facts": [{"text": "...", "date": "YYYY-MM-DD|null", "importance": 1-5}, ...]}
 * Returns [{text, date, importance}] — strings map to {text, date:null, importance:1}.
 */
export function parseFactObjects(answer, maxFacts) {
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
    let text;
    let date = null;
    let importance = 1;
    if (typeof item === 'string') {
      text = item;
    } else if (item && typeof item === 'object' && typeof item.text === 'string') {
      text = item.text;
      if (typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date)) date = item.date;
      const imp = Number(item.importance);
      if (Number.isFinite(imp) && imp >= 1) importance = Math.min(5, Math.round(imp));
    } else {
      continue;
    }
    const fact = text.trim();
    if (fact.length < 8 || fact.length > 240) continue;
    const key = fact.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ text: fact, date, importance });
    if (facts.length >= maxFacts) break;
  }
  return facts;
}

/** Extract STRICT-JSON facts array from an LLM answer, tolerantly. */
export function parseFacts(answer, maxFacts) {
  return parseFactObjects(answer, maxFacts).map((f) => f.text);
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
  let factObjects = parseFactObjects(answer, maxFacts);
  let redactions = 0;
  if (redact) {
    factObjects = factObjects.map((f) => {
      const r = redactSecrets(f.text);
      redactions += r.redactions;
      return { ...f, text: r.text };
    });
  }
  const seen = new Set();
  let written = 0;
  let skipped = 0;
  const kept = [];
  for (const fact of factObjects) {
    const key = fact.text.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    // Unified ingest pipeline: exact restatement -> noop, variant -> supersede
    // (UPDATE), new fact -> add. Date token + importance ride along so the
    // query-side temporal boost and bounded ranking factor have data.
    const result = ingestMemory(store, {
      text: fact.text,
      source: 'capture',
      date: fact.date,
      importance: fact.importance,
    });
    if (result.error || result.decision === 'noop') {
      skipped += 1;
      continue;
    }
    seen.add(key);
    kept.push(fact.text);
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
    `Output STRICT JSON only: {"facts": [{"text": "...", "date": "YYYY-MM-DD or null", "importance": 1-5}]} — at most ${maxFacts} facts; ` +
    '"date" is the calendar day the fact refers to when one is stated (else null); ' +
    '"importance": 5 for identity/core preferences and standing decisions, 1 for trivia. ' +
    'Empty array when nothing durable appears.'
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
