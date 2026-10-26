// @local/dsh-memory-core — shared pure helpers (no external dependencies).
import { createHash } from 'node:crypto';

/** Compute the revision of a source document: sha256 hex of its bytes-as-utf8. */
export function computeRevision(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** UTC ISO-8601 timestamp with milliseconds. */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Parse a minimal YAML-ish frontmatter block (`---` fences, `key: value` lines).
 * Only flat string values are supported; quotes are stripped; blank/comment
 * lines are skipped. Returns `{}` when no valid block is present.
 */
export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Split a comma/space separated keywords string into a trimmed array. */
export function parseKeywords(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(/[,;，；]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Derive a stable anchor for a document, in priority order:
 * 1. explicit frontmatter `anchor`;
 * 2. `ADR-###` captured from the filename (decision records);
 * 3. slugified relative path (directory included, so names stay unique per
 *    root without content-dependent suffixes).
 *
 * The anchor is the document's IDENTITY and must not change when content
 * changes — that is what `revision` (content hash) is for. A content-hash
 * fallback is only used when the path yields no usable slug (e.g. CJK-only
 * filenames).
 */
export function deriveAnchor({ frontmatter, relativePath, revision }) {
  if (frontmatter.anchor && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(frontmatter.anchor)) {
    return frontmatter.anchor;
  }
  const base = relativePath.split(/[\\/]/).pop() ?? relativePath;
  const adr = base.match(/^ADR-(\d{1,4})/i);
  if (adr) return `ADR-${adr[1].padStart(3, '0')}`;
  const slug = relativePath
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .toLowerCase();
  return slug || `doc-${revision.slice(0, 8)}`;
}

/** Escape one raw term into an FTS5 quoted string literal. */
export function ftsQuote(term) {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Tokenize a free-text query into terms safe for FTS5 MATCH. */
export function ftsTerms(query) {
  return query
    .split(/[\s,，、;；]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/["*()]/g, ''));
}

/**
 * CJK detection for the hybrid-rank boost, transplanted from Clowder's
 * CJK_NN_WEIGHT rationale: BM25/FTS recall is weak for Chinese text, so the
 * vector lane gets a higher fusion weight for CJK queries.
 */
export function hasCJKCharacters(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

export const EVIDENCE_KINDS = ['decision', 'lesson', 'note', 'event', 'person', 'project'];
export const EVIDENCE_STATUSES = [
  'active',
  'captured',
  'accepted',
  'superseded',
  'retired',
  'stale',
  'invalidated',
];
export const INACTIVE_STATUSES = new Set(['superseded', 'retired', 'stale', 'invalidated', 'archived', 'historical', 'drifted']);

/**
 * Half-life (days) per document kind for recency decay, transplanted from
 * Clowder's `KIND_HALF_LIVES` (recency-decay.ts): decisions age slowest,
 * transient notes fastest. Unlisted kinds default to 45 days.
 */
export const KIND_HALF_LIVES = {
  decision: 180,
  lesson: 90,
  person: 365,
  project: 120,
  note: 45,
  event: 45,
};

/**
 * Clowder-style fractional decay: factor = T/(T+age) — smooth, monotonic,
 * never zero. `updatedAt` is an ISO timestamp; invalid dates yield 1.
 */
export function computeRecencyDecay(updatedAt, kind, now = Date.now()) {
  const halfLife = KIND_HALF_LIVES[kind] ?? 45;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 1;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return halfLife / (halfLife + ageDays);
}

// ------------------------------------------------------- probe decomposition

/** Shared stopword list for probe/content-word decomposition. */
export const PROBE_STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'me', 'i', 'you', 'your', 'that', 'this',
  'of', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'were', 'in', 'on',
  'about', 'from', 'with', 'please', 'kindly', 'just', 'now', 'also',
  'fact', 'facts', 'information', 'memory', 'record', 'records',
]);

/**
 * Multi-probe decomposition of a query into fallback probes: the full
 * phrase, first-2/last-2 content-word sub-phrases, and CJK bigrams (trigram
 * FTS cannot match 2-char CJK terms; a LIKE over a bigram can). Mirrors the
 * E2 strategy validated in Bemula / the multiProbeSearch consumer.
 */
export function buildProbes(query) {
  const probes = [String(query)];
  const words = String(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !PROBE_STOPWORDS.has(w.toLowerCase()));
  if (words.length >= 2) probes.push(words.slice(0, 2).join(' '));
  if (words.length > 2) probes.push(words.slice(-2).join(' '));
  for (const run of String(query).match(/\p{Script=Han}+/gu) ?? []) {
    for (let i = 0; i + 2 <= run.length && i < 8; i += 2) {
      probes.push(run.slice(i, i + 2));
    }
    // Odd-length runs: the +2 stride skips the final character pair.
    if (run.length >= 2 && run.length % 2 === 1) {
      probes.push(run.slice(run.length - 2));
    }
  }
  return [...new Set(probes.filter((p) => p && p.length > 0))];
}

// ------------------------------------------------------------ time parsing

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86_400_000);
}

function addMonths(d, n) {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
}

/**
 * Time-aware query expansion (LongMemEval retrieval optimization): extract
 * an absolute date window from natural language time expressions. Returns
 * `{ since, until }` as YYYY-MM-DD strings (same token format the forget
 * service uses in keywords) or null when no time signal is present.
 * Deterministic regex matching — no LLM involved.
 */
export function parseTemporalQuery(text, now = new Date()) {
  const s = String(text ?? '');
  let m;
  // Absolute day: 2024-12-05 / 2024/12/05
  if ((m = s.match(/\b(\d{4})[-/](\d{2})[-/](\d{2})\b/))) {
    return { since: `${m[1]}-${m[2]}-${m[3]}`, until: `${m[1]}-${m[2]}-${m[3]}` };
  }
  // Absolute month: 2024年12月 / 2024-12 / 2024/12 / Dec 2024
  if ((m = s.match(/\b(\d{4})[-/年](\d{1,2})月?/))) {
    const y = m[1];
    const mo = String(Number(m[2])).padStart(2, '0');
    const start = new Date(Date.UTC(Number(y), Number(mo) - 1, 1));
    return { since: fmtDate(start), until: fmtDate(addDays(addMonths(start, 1), -1)) };
  }
  // Absolute year: 2024年 / in 2024
  if ((m = s.match(/\b(19|20)\d{2}\s*年\b|\bin\s+((?:19|20)\d{2})\b/))) {
    const y = (m[2] ?? m[0].replace(/\D/g, '')).slice(0, 4);
    return { since: `${y}-01-01`, until: `${y}-12-31` };
  }
  // Relative calendar units
  if (/(上个月|上个月|last month)/i.test(s)) {
    const start = addMonths(now, -1);
    return { since: fmtDate(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))), until: fmtDate(addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), -1)) };
  }
  if (/(这个月|本月|this month)/i.test(s)) {
    return { since: fmtDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), until: fmtDate(now) };
  }
  if (/(去年|last year)/i.test(s)) {
    const y = now.getUTCFullYear() - 1;
    return { since: `${y}-01-01`, until: `${y}-12-31` };
  }
  if (/(今年|this year)/i.test(s)) {
    const y = now.getUTCFullYear();
    return { since: `${y}-01-01`, until: fmtDate(now) };
  }
  if (/(上周|last week)/i.test(s)) {
    return { since: fmtDate(addDays(now, -13)), until: fmtDate(addDays(now, -7)) };
  }
  if (/(本周|this week)/i.test(s)) {
    return { since: fmtDate(addDays(now, -6)), until: fmtDate(now) };
  }
  // Relative spans: 最近/近/past/last/recent N 天|日|days|周|weeks|个月|月|months|年|years
  if ((m = s.match(/(?:最近|近|past|last|recent)\s*(\d{1,3})\s*(天|日|days?|weeks?|周|个月|months?|月|years?|年)/i))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (/(天|日|day)/.test(unit)) return { since: fmtDate(addDays(now, -n)), until: fmtDate(now) };
    if (/(week|周)/.test(unit)) return { since: fmtDate(addDays(now, -7 * n)), until: fmtDate(now) };
    if (/(month|月)/.test(unit)) return { since: fmtDate(addMonths(now, -n)), until: fmtDate(now) };
    return { since: fmtDate(addMonths(now, -12 * n)), until: fmtDate(now) };
  }
  return null;
}
