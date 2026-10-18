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
