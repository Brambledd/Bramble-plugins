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
import { VectorStore } from './vector-store.js';
import { cosine } from './embedding.js';
import {
  computeRevision,
  nowIso,
  ftsTerms,
  ftsQuote,
  INACTIVE_STATUSES,
  computeRecencyDecay,
  hasCJKCharacters,
  buildProbes,
  parseTemporalQuery,
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
    lastAccessed: row.last_accessed ?? null,
    importance: typeof row.importance === 'number' && row.importance > 0 ? row.importance : 1,
  };
}

/** Importance clamp: 1..5 (Generative Agents style rating), default 1. */
function clampImportance(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 1;
  return Math.min(5, Math.max(1, n));
}

/**
 * Decay clock (MemoryBank/间隔重复 semantics): retrieval practice strengthens
 * a memory, so decay counts from the last ACCESS when fresher than the last
 * content change. Retraction markers stay decay-exempt at the call site.
 */
function decayClock(item) {
  if (item.lastAccessed) {
    const a = Date.parse(item.lastAccessed);
    const u = Date.parse(item.updatedAt);
    if (Number.isFinite(a) && Number.isFinite(u) && a > u) return item.lastAccessed;
  }
  return item.updatedAt;
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
    this.vectors = new VectorStore(this);
    /** Optional embedding backend for the vector lane (set via attachEmbedding). */
    this.embedding = null;
    /** Embedding text projection: how a document becomes model input. */
    this.embeddingText = (item) => `${item.title}\n${item.summary ?? ''}\n${item.keywords.join(' ')}`;
    /** Async recompute queue guards (lazy backfill on search). */
    this._backfillInFlight = new Set();
  }

  /** Attach an embedding backend; enables the hybrid vector lane. */
  attachEmbedding(backend, { embeddingText } = {}) {
    this.embedding = backend;
    if (typeof embeddingText === 'function') this.embeddingText = embeddingText;
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
    const updatedAt = unchanged ? prev.updated_at : (item.updatedAt ?? nowIso());
    const importance = clampImportance(item.importance);
    this.db
      .prepare(
        `INSERT INTO evidence_docs
            (anchor, kind, status, authority, title, summary, keywords, source_path, source_hash, superseded_by, updated_at, importance)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(anchor) DO UPDATE SET
            kind=excluded.kind, status=excluded.status, authority=excluded.authority,
            title=excluded.title, summary=excluded.summary, keywords=excluded.keywords,
            source_path=excluded.source_path, source_hash=excluded.source_hash,
            superseded_by=excluded.superseded_by, updated_at=excluded.updated_at,
            importance=excluded.importance`,
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
        importance,
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
   * Hybrid search: BM25 (trigram FTS5) fused with the vector lane via RRF
   * (k=60). CJK queries weight the vector lane ×1.5 (Clowder CJK_NN_WEIGHT
   * rationale). Fused scores get the recency-decay penalty; results are
   * MMR-reranked for diversity when fresh vectors exist; inactive/superseded
   * rows are demoted. A final LIKE fallback covers sub-trigram CJK terms.
   *
   * The vector lane participates only when an embedding backend is attached
   * and fresh (revision-matching) vectors exist; otherwise this degrades
   * gracefully to the pure BM25 pipeline.
   * @returns {{items: EvidenceItem[], scores: number[], matchMode: string|null}}
   */
  /**
   * Synchronous search. When the attached backend supports synchronous
   * embedding (`embedOne`, e.g. the default hash backend) the vector lane
   * participates; async backends (OpenAI-compatible) use searchHybrid().
   */
  search(options) {
    const query = options?.query ?? '';
    let queryVec = null;
    if (this.embedding && typeof this.embedding.embedOne === 'function') {
      try {
        queryVec = this.embedding.embedOne(query);
      } catch {
        queryVec = null;
      }
    }
    return this.runHybrid({ ...options, queryVec });
  }

  /** Async search for async embedding backends (OpenAI-compatible). */
  async searchHybrid(options) {
    const query = options?.query ?? '';
    let queryVec = null;
    if (this.embedding) {
      try {
        const vecs = await this.embedding.embed([query]);
        queryVec = vecs[0] ?? null;
      } catch {
        queryVec = null;
      }
    }
    return this.runHybrid({ ...options, queryVec });
  }

  /** Shared hybrid pipeline: RRF fusion -> tiered expansion -> decay -> demote -> MMR. */
  runHybrid({ query, queryVec, kinds, limit = 8, includeInactive = false, recencyDecay = true }) {
    const kindSet = Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds) : null;
    let fts = this.ftsCandidates(query);
    let ftsItems = fts.items.filter((i) => !kindSet || kindSet.has(i.kind));
    let probeFallback = false;

    // L1 probe fallback: only when primary recall is empty — CJK bigram /
    // sub-phrase probes recover matches the whole phrase cannot reach
    // (LongMemEval query-side expansion, Bemula E2 probes).
    if (ftsItems.length === 0) {
      const seen = new Set();
      const merged = [];
      for (const probe of buildProbes(query)) {
        if (probe === query) continue;
        const attempt = this.ftsCandidates(probe);
        for (const item of attempt.items) {
          if (kindSet && !kindSet.has(item.kind)) continue;
          if (!seen.has(item.anchor)) {
            seen.add(item.anchor);
            merged.push(item);
          }
        }
      }
      if (merged.length > 0) {
        ftsItems = merged;
        fts = { ...fts, viaLike: true };
        probeFallback = true;
      }
    }

    // Resolve vector hits to full items BEFORE fusing — vec-only hits (the
    // cross-vocabulary gap the vector lane exists for) must survive fusion.
    let vecItems = [];
    if (queryVec) {
      for (const hit of this.vectors.knn(queryVec, { model: this.embedding?.model, limit: 50 })) {
        const item = this.getByAnchor(hit.anchor);
        if (!item) continue;
        if (kindSet && !kindSet.has(item.kind)) continue;
        vecItems.push(item);
      }
    }
    const mode =
      vecItems.length > 0
        ? 'hybrid:fts+vec'
        : ftsItems.length > 0
          ? probeFallback
            ? 'probe-fallback'
            : fts.viaLike
              ? 'like-fallback'
              : 'fts'
          : null;
    const scored = rrfFuse(ftsItems, vecItems, { cjkBoost: hasCJKCharacters(query) });

    // L2 link fill (A-MEM 1-hop, bounded): only when primary recall is thin,
    // never displacing L0 positions.
    if (scored.length > 0 && scored.length < limit) {
      const topAnchors = scored.slice(0, 3).map((s) => s.item.anchor);
      const exclude = new Set(scored.map((s) => s.item.anchor));
      const topScore = scored[0].score || 1;
      for (const neighbor of this.linkNeighbors(topAnchors, { exclude, cap: 2 })) {
        if (kindSet && !kindSet.has(neighbor.kind)) continue;
        if (!includeInactive && (INACTIVE_STATUSES.has(neighbor.status) || neighbor.supersededBy)) continue;
        scored.push({ item: neighbor, score: topScore * 0.5 });
      }
    }

    // Time-aware soft boost (LongMemEval): when the query carries a time
    // window, entries whose keyword date tokens fall inside it surface
    // first. A boost, never a filter — missing tokens just rank naturally.
    const window = parseTemporalQuery(query);
    if (window) {
      for (const entry of scored) {
        const tokens = entry.item.keywords.filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
        if (tokens.some((t) => t >= window.since && t <= window.until)) {
          entry.score += 1;
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);
    if (recencyDecay) {
      const now = Date.now();
      for (const entry of scored) {
        // Retraction markers are exempt: a forgotten topic's deny-list must
        // not fade with disuse (clowder-ai constitutional semantics).
        if (entry.item.kind === 'retraction') continue;
        // RRF scores are higher-is-better; decay ∈ (0,1] so its log is a
        // negative bonus — stale rows sink without dominating lexical rank.
        entry.score += Math.log(computeRecencyDecay(decayClock(entry.item), entry.item.kind, now));
      }
      scored.sort((a, b) => b.score - a.score);
    }
    // Importance as a BOUNDED multiplicative nudge (Generative Agents third
    // factor), never an open-ended boost: ×0.8 (imp 2) … ×1.2 (imp 5), and
    // markers keep ×1.0. The invariant holds: lexical rank stays primary.
    for (const entry of scored) {
      const imp = entry.item.importance ?? 1;
      if (imp > 1 && entry.item.kind !== 'retraction') {
        entry.score *= 0.8 + 0.1 * (clampImportance(imp) - 1);
      }
    }
    scored.sort((a, b) => b.score - a.score);
    if (!includeInactive) {
      scored.sort(
        (a, b) =>
          Number(isInactive(a.item) || Boolean(a.item.supersededBy)) -
          Number(isInactive(b.item) || Boolean(b.item.supersededBy)),
      );
    }
    let top = scored.slice(0, Math.max(1, limit));
    if (this.embedding && vecItems.length > 0 && top.length > 2) {
      top = mmrRerank(top, {
        vectorsFor: (item) => this.vectors.freshFor(item.anchor, item.revision),
      });
    }
    return {
      items: top.map((t) => t.item),
      scores: top.map((t) => t.score),
      matchMode: mode,
    };
  }

  /** BM25 candidates as {items, viaLike} in rank order. */
  ftsCandidates(query) {
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
        continue;
      }
      if (rows.length > 0) {
        return { items: rows.map((r) => rowToItem(r)), viaLike: false };
      }
    }
    // LIKE fallback: substring containment over the indexed text fields.
    const terms = ftsTerms(query);
    if (terms.length > 0) {
      const conditions = terms.map(() => "(title || ' ' || COALESCE(summary,'') || ' ' || COALESCE(keywords,'')) LIKE ? ESCAPE '\\'").join(' OR ');
      const params = terms.map((t) => `%${escapeLike(t)}%`);
      const rows = this.db
        .prepare(`SELECT d.*, 0 AS score FROM evidence_docs d WHERE ${conditions} LIMIT 200`)
        .all(...params);
      if (rows.length > 0) return { items: rows.map((r) => rowToItem(r)), viaLike: true };
    }
    return { items: [], viaLike: false };
  }

  /**
   * Vector candidates via an explicitly provided query vector (used by
   * runHybrid). Kept for callers that pre-compute embeddings.
   */
  vectorCandidatesWith(queryVec) {
    if (!queryVec) return [];
    return this.vectors.knn(queryVec, { model: this.embedding?.model, limit: 50 });
  }

  /**
   * Backfill/recompute embeddings for documents whose vector rows are
   * missing or stale. Budgeted per call (batch size); safe to call from
   * startup jobs or lazily after searches.
   * @returns {Promise<{embedded: number, model: string}>}
   */
  async embedBackfill({ batchSize = 16 } = {}) {
    if (!this.embedding) return { embedded: 0, model: null };
    const rows = this.db
      .prepare(
        `SELECT d.anchor, d.source_hash FROM evidence_docs d
         LEFT JOIN evidence_vectors v ON v.anchor = d.anchor AND v.revision = d.source_hash AND v.model = ?
         WHERE v.anchor IS NULL`,
      )
      .all(this.embedding.model)
      .slice(0, batchSize);
    if (rows.length === 0) return { embedded: 0, model: this.embedding.model };
    const texts = [];
    for (const row of rows) {
      const item = this.getByAnchor(row.anchor);
      texts.push(this.embeddingText(item));
    }
    const vecs = await this.embedding.embed(texts);
    let embedded = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const vec = vecs[i];
      if (!vec) continue;
      this.vectors.put({
        anchor: rows[i].anchor,
        revision: rows[i].source_hash,
        model: this.embedding.model,
        vec,
      });
      embedded += 1;
    }
    return { embedded, model: this.embedding.model };
  }

  /**
   * 回源校验 read: re-hash the source file and only serve content when it
   * still matches the indexed revision. Content is truncated at `maxChars`
   * (default 8000) to bound context consumption; `truncated` flags it and
   * `totalChars` reports the full length so callers know to read the source
   * file directly for more.
   * @returns {Promise<
   *   | {status:'ok', anchor:string, revision:string, kind:string, docStatus:string, title:string, content:string, truncated:boolean, totalChars:number}
   *   | {status:'not_available', anchor:string, invalidationReason:
   *       'not_found'|'no_source'|'source_missing'|'source_modified'|'stale_revision'|'inactive'}>
   */
  async drill({ anchor, expectedRevision, maxChars = 8000 }) {
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
    // Retrieval practice strengthens memory (spaced repetition): stamp the
    // access so recency decay counts from here instead of updatedAt.
    this.touchAnchor(anchor);
    const totalChars = content.length;
    const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : totalChars;
    const truncated = totalChars > cap;
    return {
      status: 'ok',
      anchor,
      revision: item.revision,
      kind: item.kind,
      docStatus: item.status,
      title: item.title,
      content: truncated ? content.slice(0, cap) : content,
      truncated,
      totalChars,
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

  /** Wipe the derived index (documents, FTS, vectors). Ledger and roots stay. */
  wipe() {
    this.db.exec('DELETE FROM evidence_docs;');
    this.db.exec('DELETE FROM evidence_vectors;');
    return true;
  }

  /**
   * Hard-remove one document from the derived index: the evidence row (FTS
   * triggers mirror the delete), its vector row, and every memory link
   * touching it. Link cleanup is what keeps links from becoming a
   * resurrection channel for forgotten content — a deleted anchor's
   * neighbors must never pull it back via 1-hop expansion.
   * Cue-ledger entries for the anchor survive — they hold anchor + revision
   * only, never content.
   */
  removeByAnchor(anchor) {
    this.db.prepare('DELETE FROM evidence_docs WHERE anchor = ?').run(anchor);
    this.db.prepare('DELETE FROM evidence_vectors WHERE anchor = ?').run(anchor);
    this.db
      .prepare('DELETE FROM evidence_links WHERE anchor = ? OR linked_anchor = ?')
      .run(anchor, anchor);
  }

  // ------------------------------------------------------ memory links

  /** Record a symmetric similarity edge (A-MEM dynamic linking). */
  putLink(anchor, linkedAnchor, score = 1) {
    if (!anchor || !linkedAnchor || anchor === linkedAnchor) return false;
    this.db
      .prepare(
        `INSERT INTO evidence_links (anchor, linked_anchor, score, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(anchor, linked_anchor) DO UPDATE SET score = excluded.score`,
      )
      .run(anchor, linkedAnchor, score, nowIso());
    return true;
  }

  /**
   * 1-hop neighbors of the given anchors (either direction), freshest edges
   * first, excluding the query set itself.
   */
  linkNeighbors(anchors, { exclude = new Set(), cap = 2 } = {}) {
    if (!Array.isArray(anchors) || anchors.length === 0 || cap <= 0) return [];
    const placeholders = anchors.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT anchor, linked_anchor, score FROM evidence_links
         WHERE anchor IN (${placeholders}) OR linked_anchor IN (${placeholders})
         ORDER BY score DESC, created_at DESC`,
      )
      .all(...anchors, ...anchors);
    const out = [];
    const seen = new Set(exclude);
    for (const row of rows) {
      const other = anchors.includes(row.anchor) ? row.linked_anchor : row.anchor;
      if (seen.has(other)) continue;
      const item = this.getByAnchor(other);
      if (!item) continue;
      seen.add(other);
      out.push(item);
      if (out.length >= cap) break;
    }
    return out;
  }

  /** Stamp the last access time (drill / successful verified read). */
  touchAnchor(anchor) {
    try {
      this.db.prepare('UPDATE evidence_docs SET last_accessed = ? WHERE anchor = ?').run(nowIso(), anchor);
    } catch {
      // Pre-migration database without the column — decay falls back to updatedAt
    }
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
      vectors: this.vectors.stats(),
      vectorBackend: this.embedding ? this.embedding.model : null,
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

/**
 * Reciprocal-rank fusion of the two lanes (higher score is better).
 * ftsItems and vecItems are EvidenceItem[] arrays, each in its lane's rank
 * order. Every lane contributes weight/(K + rank) per item it contains;
 * K=60 is the standard RRF constant. CJK queries boost the vector lane by
 * ×1.5 (Clowder CJK_NN_WEIGHT rationale). Items hit by only one lane keep
 * that lane's contribution — vec-only hits are the cross-vocabulary wins.
 * @returns {{item: EvidenceItem, score: number}[]} sorted by score desc
 */
export function rrfFuse(ftsItems, vecItems, { cjkBoost = false, k = 60 } = {}) {
  const vecWeight = cjkBoost ? 1.5 : 1;
  const byAnchor = new Map();
  ftsItems.forEach((item, rank) => {
    byAnchor.set(item.anchor, { item, score: 1 / (k + rank) });
  });
  vecItems.forEach((item, rank) => {
    const existing = byAnchor.get(item.anchor);
    const contribution = vecWeight / (k + rank);
    if (existing) {
      existing.score += contribution;
    } else {
      byAnchor.set(item.anchor, { item, score: contribution });
    }
  });
  const list = [...byAnchor.values()];
  list.sort((a, b) => b.score - a.score);
  return list;
}

/**
 * Maximal-marginal-relevance rerank for diversity: greedily pick the item
 * maximizing λ·relevance - (1-λ)·max-similarity-to-already-picked, using
 * fresh vectors. Items without vectors contribute zero similarity.
 */
export function mmrRerank(scored, { vectorsFor, lambda = 0.7 } = {}) {
  const pool = scored.map((entry) => ({
    ...entry,
    relevance: entry.score,
    vec: vectorsFor(entry.item)?.vec ?? null,
  }));
  const picked = [];
  while (pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      let maxSim = 0;
      if (pool[i].vec) {
        for (const p of picked) {
          if (!p.vec) continue;
          const sim = cosine(pool[i].vec, p.vec);
          if (sim > maxSim) maxSim = sim;
        }
      }
      const mmr = lambda * pool[i].relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIndex = i;
      }
    }
    picked.push(pool.splice(bestIndex, 1)[0]);
  }
  return picked.map(({ item, score }) => ({ item, score }));
}
