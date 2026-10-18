// @local/dsh-memory-core — vector lane storage (BLOB + JS cosine).
//
// Vectors are stored as Float32Array BLOBs keyed by anchor, stamped with the
// document revision and the embedding model identity. A vector row is only
// served when its revision still matches the evidence row (fail-closed like
// every derived read); stale rows are invisible to search and queued for
// recomputation. Zero native extensions by design: an in-memory scan is fast
// for personal-knowledge scale (10k x 256 dims ≈ 10 MB sweep per query).
import { cosine } from './embedding.js';

export class VectorStore {
  /** @param {import('./store.js').EvidenceStore} store the owning evidence store */
  constructor(store) {
    this.store = store;
  }

  put({ anchor, revision, model, vec }) {
    this.store.db
      .prepare(
        `INSERT INTO evidence_vectors (anchor, revision, model, dims, vec, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(anchor) DO UPDATE SET
           revision=excluded.revision, model=excluded.model, dims=excluded.dims,
           vec=excluded.vec, updated_at=excluded.updated_at`,
      )
      .run(anchor, revision, model, vec.length, packVector(vec), new Date().toISOString());
  }

  /**
   * The fresh vector row for an anchor, or null when absent or stale.
   * Freshness is measured against the evidence row's CURRENT revision —
   * a vector stamped with an older revision is invisible everywhere.
   */
  freshFor(anchor, revisionHint) {
    const row = this.store.db
      .prepare(
        `SELECT v.revision, v.model, v.dims, v.vec
         FROM evidence_vectors v JOIN evidence_docs d ON d.anchor = v.anchor
         WHERE v.anchor = ? AND v.revision = d.source_hash`,
      )
      .get(anchor);
    if (!row) return null;
    if (typeof revisionHint === 'string' && revisionHint.length > 0 && row.revision !== revisionHint) {
      return null;
    }
    return { model: row.model, dims: row.dims, vec: unpackVector(row.vec, row.dims) };
  }

  /** All fresh vector rows (skips stale ones) as [{anchor, model, dims, vec}]. */
  loadFresh() {
    const rows = this.store.db
      .prepare(
        `SELECT v.anchor, v.revision, v.model, v.dims, v.vec
         FROM evidence_vectors v JOIN evidence_docs d ON d.anchor = v.anchor
         WHERE v.revision = d.source_hash`,
      )
      .all();
    return rows.map((r) => ({ anchor: r.anchor, model: r.model, dims: r.dims, vec: unpackVector(r.vec, r.dims) }));
  }

  /**
   * K nearest anchors to `queryVec` by cosine, restricted to fresh rows of
   * the given model. Returns [{anchor, score}] sorted by descending cosine.
   */
  knn(queryVec, { model, limit = 50 } = {}) {
    const results = [];
    for (const row of this.loadFresh()) {
      if (model && row.model !== model) continue;
      if (row.vec.length !== queryVec.length) continue;
      results.push({ anchor: row.anchor, score: cosine(queryVec, row.vec) });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, Math.max(1, limit));
  }

  /** Coverage snapshot: fresh vectors / total docs, by model. */
  stats() {
    const total = this.store.db.prepare('SELECT COUNT(*) AS n FROM evidence_docs').get().n;
    const fresh = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM evidence_vectors v JOIN evidence_docs d ON d.anchor = v.anchor
         WHERE v.revision = d.source_hash`,
      )
      .get().n;
    const stale = this.store.db.prepare('SELECT COUNT(*) AS n FROM evidence_vectors').get().n - fresh;
    return { total, fresh, stale };
  }

  wipe() {
    this.store.db.exec('DELETE FROM evidence_vectors;');
  }
}

export function packVector(vec) {
  return Buffer.from(new Float32Array(vec).buffer, 0, vec.length * 4);
}

export function unpackVector(blob, dims) {
  const buf = Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, dims);
}
