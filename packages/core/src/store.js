// @local/dsh-memory-core — EvidenceStore: the derived evidence index.
//
// Design contracts (from the M1 plan):
// - Truth lives in source files; this SQLite index is derived and rebuildable.
// - Every stored row carries `source_hash` (the revision); drill() always
//   re-reads and re-hashes the source before serving content (回源校验).
// - Derived reads fail closed: a missing/changed source surfaces as
//   `not_available` with a machine-readable invalidationReason, never as
//   stale content.
import { readFile } from 'node:fs/promises';
import { openEvidenceDatabase, EVIDENCE_SCHEMA_VERSION } from './schema.js';
import {
  computeRevision,
  nowIso,
  ftsTerms,
  ftsQuote,
  INACTIVE_STATUSES,
  computeRecencyDecay,
} from './util.js';

/** @typedef {{anchor:string, kind:string, status:string, authority:string, title:string, summary:string|null, keywords:string[], sourcePath:string|null, revision:string|null, supersededBy:string|null, updatedAt:string}} EvidenceItem */

function rowToItem(row) {
  if (!row) return null;
  return {
    anchor: row.anchor,
    kind: row.kind,
    status: row.status,
    authority: row.authority ?? 'standard',
    title: row.title,
    summary: row.summary ?? null,
    keywords: row.keywords ? row.keywords.split(',').map((s) => s.trim()).filter(Boolean) : [],
    sourcePath: row.source_path ?? null,
    revision: row.source_hash ?? null,
    supersededBy: row.superseded_by ?? null,
    updatedAt: row.updated_at,
  };
}

/**
 * Progressive FTS5 MATCH strategies: exact AND, then OR, then prefix OR.
 * Mirrors Clowder's progressive-query approach for CJK-friendly recall.
 */
function buildMatchCandidates(query) {
  const terms = ftsTerms(query);
  if (terms.length === 0) return [];
  const quoted = terms.map(ftsQuote);
  const candidates = [quoted.join(' '), quoted.join(' OR ')];
  const prefix = terms.map((t) => `${ftsQuote(t)}*`).join(' OR ');
  if (prefix !== quoted.join(' ')) candidates.push(prefix);
  return [...new Set(candidates)];
}

export class EvidenceStore {
  /** @param {string} path file path or ':memory:' */
  constructor(path) {
    this.path = path;
    const { db, reset } = openEvidenceDatabase(path);
    this.db = db;
    this.schemaVersion = EVIDENCE_SCHEMA_VERSION;
    this.resetOnOpen = reset;
  }

  close() {
    this.db.close();
  }

  // --------------------------------------------------------------- writes

  /**
   * Insert or refresh one evidence row. Content-unchanged writes keep the
   * previous `updated_at` (idempotent re-index).
   * @param {EvidenceItem & {revision?: string}} item
   */
  upsert(item) {
    const prev = this.db
      .prepare('SELECT source_hash, updated_at FROM evidence_docs WHERE anchor = ?')
      .get(item.anchor);
    const unchanged =
      prev !== undefined &&
      prev.source_hash === item.revision &&
      prev.updated_at !== undefined;
    const updatedAt = unchanged ? prev.updated_at : nowIso();
    this.db
      .prepare(
        `INSERT INTO evidence_docs
           (anchor, kind, status, authority, title, summary, keywords, source_path, source_hash, superseded_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(anchor) DO UPDATE SET
           kind=excluded.kind, status=excluded.status, authority=excluded.authority,
           title=excluded.title, summary=excluded.summary, keywords=excluded.keywords,
           source_path=excluded.source_path, source_hash=excluded.source_hash,
           superseded_by=excluded.superseded_by, updated_at=excluded.updated_at`,
      )
      .run(
        item.anchor,
        item.kind,
        item.status,
        item.authority ?? 'standard',
        item.title,
        item.summary ?? null,
        (item.keywords ?? []).join(','),
        item.sourcePath ?? null,
        item.revision ?? null,
        item.supersededBy ?? null,
        updatedAt,
      );
    return { anchor: item.anchor, updated: !unchanged };
  }

  /** Mark `anchor` as replaced by `byAnchor` (Clowder supersede semantics). */
  supersede(anchor, byAnchor) {
    const result = this.db
      .prepare(
        `UPDATE evidence_docs SET superseded_by = ?, status = 'superseded', updated_at = ?
         WHERE anchor = ?`,
      )
      .run(byAnchor, nowIso(), anchor);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------- reads

  getByAnchor(anchor) {
    return rowToItem(
      this.db.prepare('SELECT * FROM evidence_docs WHERE anchor = ?').get(anchor),
    );
  }

  /**
   * Full-text search over the evidence index (BM25, trigram tokenizer), with
   * inactive/superseded rows demoted to the tail and a Clowder-style
   * fractional recency decay folded into ranking (`T/(T+age)` per kind).
   * A final LIKE fallback phase covers sub-trigram CJK terms.
   * @returns {{items: EvidenceItem[], scores: number[], matchMode: string|null}}
   */
  search({ query, kinds, limit = 8, includeInactive = false, recencyDecay = true }) {
    const kindSet = Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds) : null;
    const finalize = (rows, matchMode) => {
      let items = rows.map((r) => ({ row: r, item: rowToItem(r) }));
      if (kindSet) items = items.filter((x) => kindSet.has(x.item.kind));
      if (recencyDecay) {
        const now = Date.now();
        for (const entry of items) {
          const decay = computeRecencyDecay(entry.item.updatedAt, entry.item.kind, now);
          // bm25 is lower-is-better; a log penalty keeps ranking smooth and
          // monotonic without letting decay dominate lexical relevance.
          entry.row.score = (entry.row.score ?? 0) - Math.log(decay);
        }
        items.sort((a, b) => (a.row.score ?? 0) - (b.row.score ?? 0));
      }
      if (!includeInactive) {
        // Stable partition: active rows first, inactive demoted (not hidden).
        items.sort(
          (a, b) =>
            Number(isInactive(a.item) || Boolean(a.item.supersededBy)) -
            Number(isInactive(b.item) || Boolean(b.item.supersededBy)),
        );
      }
      const sliced = items.slice(0, Math.max(1, limit));
      return {
        items: sliced.map((x) => x.item),
        scores: sliced.map((x) => x.row.score ?? 0),
        matchMode,
      };
    };
    for (const match of buildMatchCandidates(query)) {
      let rows;
      try {
        rows = this.db
          .prepare(
            `SELECT d.*, bm25(evidence_fts) AS score
             FROM evidence_fts JOIN evidence_docs d ON d.rowid = evidence_fts.rowid
             WHERE evidence_fts MATCH ?
             ORDER BY score LIMIT 200`,
          )
          .all(match);
      } catch {
        continue; // malformed MATCH fallback — try the next strategy
      }
      if (rows.length > 0) return finalize(rows, match);
    }
    // LIKE fallback: substring containment over the indexed text fields.
    const terms = ftsTerms(query);
    if (terms.length > 0) {
      const conditions = terms.map(() => "(title || ' ' || COALESCE(summary,'') || ' ' || COALESCE(keywords,'')) LIKE ? ESCAPE '\\'").join(' OR ');
      const params = terms.map((t) => `%${escapeLike(t)}%`);
      const rows = this.db
        .prepare(`SELECT d.*, 0 AS score FROM evidence_docs d WHERE ${conditions} LIMIT 200`)
        .all(...params);
      if (rows.length > 0) return finalize(rows, 'like-fallback');
    }
    return { items: [], scores: [], matchMode: null };
  }

  /**
   * 回源校验 read: re-hash the source file and only serve content when it
   * still matches the indexed revision.
   * @returns {Promise<
   *   | {status:'ok', anchor:string, revision:string, kind:string, docStatus:string, title:string, content:string}
   *   | {status:'not_available', anchor:string, invalidationReason:
   *       'not_found'|'no_source'|'source_missing'|'source_modified'|'stale_revision'|'inactive'}>
   */
  async drill({ anchor, expectedRevision }) {
    const item = this.getByAnchor(anchor);
    if (!item) {
      return { status: 'not_available', anchor, invalidationReason: 'not_found' };
    }
    if (!item.sourcePath || !item.revision) {
      return { status: 'not_available', anchor, invalidationReason: 'no_source' };
    }
    let content;
    try {
      content = await readFile(item.sourcePath, 'utf8');
    } catch {
      return { status: 'not_available', anchor, invalidationReason: 'source_missing' };
    }
    const currentRevision = computeRevision(content);
    if (currentRevision !== item.revision) {
      return { status: 'not_available', anchor, invalidationReason: 'source_modified' };
    }
    if (
      typeof expectedRevision === 'string' &&
      expectedRevision.length > 0 &&
      !revisionMatches(item.revision, expectedRevision)
    ) {
      return { status: 'not_available', anchor, invalidationReason: 'stale_revision' };
    }
    if (INACTIVE_STATUSES.has(item.status) || item.supersededBy) {
      return { status: 'not_available', anchor, invalidationReason: 'inactive' };
    }
    // Successful verified reads are themselves consumption events: record a
    // generic drill episode (idempotent; family 'drill') for utility
    // attribution. Specialized cue planes (e.g. decisions) keep their own
    // family rows and are unaffected.
    this.recordCueConsumption({
      owner: 'default',
      family: 'drill',
      sourceAnchor: anchor,
      sourceRevision: item.revision,
      terminal: 'drilled',
    });
    return {
      status: 'ok',
      anchor,
      revision: item.revision,
      kind: item.kind,
      docStatus: item.status,
      title: item.title,
      content,
    };
  }

  // -------------------------------------------------------- cue ledger

  /** Record a terminal cue consumption; idempotent per (owner, family, anchor, revision). */
  recordCueConsumption({ owner, family, sourceAnchor, sourceRevision, terminal = 'consumed' }) {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO cue_episodes
           (owner, family, source_anchor, source_revision, terminal, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(owner, family, sourceAnchor, sourceRevision, terminal, nowIso());
    return { newlyRecorded: result.changes > 0 };
  }

  /** Whether this exact revision was already terminally consumed by `owner`. */
  hasConsumedRevision({ owner, family, sourceAnchor, sourceRevision }) {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM cue_episodes
         WHERE owner = ? AND family = ? AND source_anchor = ? AND source_revision = ?`,
      )
      .get(owner, family, sourceAnchor, sourceRevision);
    return row !== undefined;
  }

  // ---------------------------------------------------- roots & rebuild

  rememberRoot(root, kindHint = null) {
    this.db
      .prepare('INSERT INTO indexed_roots (root, kind_hint) VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET kind_hint = excluded.kind_hint')
      .run(root, kindHint);
  }

  listRoots() {
    return this.db.prepare('SELECT root, kind_hint FROM indexed_roots').all();
  }

  /** Wipe the derived index (documents, FTS, ledger stays). Roots registry kept. */
  wipe() {
    this.db.exec('DELETE FROM evidence_docs;');
    // content= external table: deleting all rows through triggers is enough.
    return true;
  }

  stats() {
    const byKind = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM evidence_docs GROUP BY kind ORDER BY n DESC')
      .all();
    const byStatus = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM evidence_docs GROUP BY status ORDER BY n DESC')
      .all();
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM evidence_docs').get().n;
    const cues = this.db.prepare('SELECT COUNT(*) AS n FROM cue_episodes').get().n;
    return {
      total,
      byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      cueEpisodes: cues,
      schemaVersion: this.schemaVersion,
      roots: this.listRoots().length,
    };
  }
}

function isInactive(item) {
  return INACTIVE_STATUSES.has(item.status);
}

/**
 * Revision comparison: the full 64-char hex hash, or any unambiguous hex
 * prefix of at least 8 chars (git-style abbreviation, case-insensitive).
 * Callers routinely shorten hashes for display; a mismatch still fails
 * closed, so a prefix cannot silently serve wrong content.
 */
function revisionMatches(fullRevision, provided) {
  if (provided === fullRevision) return true;
  if (
    provided.length >= 8 &&
    provided.length < fullRevision.length &&
    /^[0-9a-f]+$/i.test(provided)
  ) {
    return fullRevision.toLowerCase().startsWith(provided.toLowerCase());
  }
  return false;
}

/** Escape LIKE wildcards inside a fallback term. */
function escapeLike(term) {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
