// @local/dsh-memory-events 鈥?event store (truth side, dedicated DB).
//
// Transplanted from Clowder's EventMemoryStore (F227): events are a TYPED
// truth-side sub-store, not a derived index. Semantics:
// - idempotent markEvent keyed by a source-coordinate hash (repeat marks
//   return inserted=false instead of duplicating);
// - hard forget = row removal + tombstone; a tombstoned coordinate can
//   never be re-marked (suppressed=true), mirroring Clowder's
//   RAISE(ABORT) fence in SQLite-native form;
// - time-windowed query (since/until) with Clowder-style fractional decay
//   ranking on occurred_at;
// - corrections are forget + re-mark under a new coordinate (the proposal
//   flow of Clowder collapses to this composition in the single-user case).
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { computeRecencyDecay, ftsTerms, ftsQuote } from '../../core/src/util.js';

export const EVENT_KINDS = ['commitment', 'outcome', 'observation', 'milestone', 'incident'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  occurred_at TEXT NOT NULL,
  due_at TEXT,
  source_key TEXT,
  source_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at);
CREATE INDEX IF NOT EXISTS events_source ON events(source_key);
CREATE TABLE IF NOT EXISTS event_tombstones (
  event_key TEXT PRIMARY KEY,
  forgotten_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  title, detail,
  content=events, content_rowid=rowid,
  tokenize='trigram'
);
`;

const FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, title, detail) VALUES (new.rowid, new.title, new.detail);
END`,
  `CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, detail) VALUES ('delete', old.rowid, old.title, old.detail);
END`,
  `CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, detail) VALUES ('delete', old.rowid, old.title, old.detail);
  INSERT INTO events_fts(rowid, title, detail) VALUES (new.rowid, new.title, new.detail);
END`,
];

/** Deterministic event key: hash of the source coordinate (explicit key preferred). */
export function computeEventKey({ sourceKey, title, kind, occurredAt }) {
  const coordinate = sourceKey ?? `${kind}|${occurredAt}|${title}`;
  return createHash('sha256').update(coordinate, 'utf8').digest('hex');
}

function rowToEvent(row) {
  return {
    eventKey: row.event_key,
    kind: row.kind,
    title: row.title,
    detail: row.detail ?? null,
    status: row.status,
    occurredAt: row.occurred_at,
    dueAt: row.due_at ?? null,
    sourceKey: row.source_key ?? null,
    sourceNote: row.source_note ?? null,
    updatedAt: row.updated_at,
  };
}

/** Hard cap on event detail text 鈥?events are one-line records, not documents. */
export const EVENT_DETAIL_MAX_CHARS = 10_000;

export class EventStore {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA journal_size_limit = 67108864;');
    this.db.exec(SCHEMA);
    for (const stmt of FTS_TRIGGERS) this.db.exec(stmt);
  }

  close() {
    this.db.close();
  }

  /**
   * Idempotent mark with tombstone suppression.
   * @returns {{event: object, inserted: boolean, suppressed?: false} | {event: null, inserted: false, suppressed: true}}
   */
  mark({ title, kind = 'observation', detail = null, occurredAt, dueAt = null, sourceKey = null, sourceNote = null }) {
    const eventKey = computeEventKey({ sourceKey, title, kind, occurredAt });
    if (this.db.prepare('SELECT 1 FROM event_tombstones WHERE event_key = ?').get(eventKey)) {
      return { event: null, inserted: false, suppressed: true };
    }
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM events WHERE event_key = ?').get(eventKey);
    if (existing) return { event: rowToEvent(existing), inserted: false };
    // Bound storage and context: event details are capped, not document stores.
    const boundedDetail =
      typeof detail === 'string' && detail.length > EVENT_DETAIL_MAX_CHARS
        ? detail.slice(0, EVENT_DETAIL_MAX_CHARS)
        : detail;
    this.db
      .prepare(
        `INSERT INTO events (event_key, kind, title, detail, status, occurred_at, due_at, source_key, source_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      )
      .run(eventKey, kind, title, boundedDetail, occurredAt, dueAt, sourceKey, sourceNote, now, now);
    return { event: rowToEvent(this.db.prepare('SELECT * FROM events WHERE event_key = ?').get(eventKey)), inserted: true };
  }

  /**
   * Resolve an event row by either its event key (64-char hex) or its source
   * key. Agents routinely quote the source coordinate they supplied; both
   * spellings must forget the same row.
   * @returns {string|null} the resolved event_key
   */
  resolveKey(eventKeyOrSourceKey) {
    const value = String(eventKeyOrSourceKey ?? '').trim();
    if (value.length === 0) return null;
    if (/^[0-9a-f]{64}$/i.test(value)) {
      const byKey = this.db.prepare('SELECT event_key FROM events WHERE event_key = ?').get(value.toLowerCase());
      if (byKey) return byKey.event_key;
      const tombstoned = this.db.prepare('SELECT event_key FROM event_tombstones WHERE event_key = ?').get(value.toLowerCase());
      if (tombstoned) return tombstoned.event_key;
    }
    const bySource = this.db.prepare('SELECT event_key FROM events WHERE source_key = ?').get(value);
    if (bySource) return bySource.event_key;
    const tombstonedSource = this.db
      .prepare(
        `SELECT t.event_key FROM event_tombstones t
         WHERE t.event_key = (SELECT event_key FROM events WHERE source_key = ?)`,
      )
      .get(value);
    if (tombstonedSource) return tombstonedSource.event_key;
    return null;
  }

  /** Hard forget by event key OR source key: remove the row and tombstone its coordinate forever. Idempotent. */
  forget(eventKeyOrSourceKey) {
    const resolved = this.resolveKey(eventKeyOrSourceKey);
    if (!resolved) {
      return { forgotten: false, alreadyForgotten: false, error: 'not_found' };
    }
    const tombstoned = this.db
      .prepare('INSERT OR IGNORE INTO event_tombstones (event_key, forgotten_at) VALUES (?, ?)')
      .run(resolved, new Date().toISOString()).changes;
    const removed = this.db.prepare('DELETE FROM events WHERE event_key = ?').run(resolved).changes;
    return { forgotten: tombstoned > 0 || removed > 0, alreadyForgotten: tombstoned === 0 && removed === 0, eventKey: resolved };
  }

  /** Time-windowed + full-text query with half-life ranking on occurred_at. */
  search({ query, kinds, since, until, limit = 20, includeRetired = false, recencyDecay = true } = {}) {
    const clauses = [];
    const params = [];
    if (!includeRetired) clauses.push("status = 'active'");
    if (kinds && kinds.length > 0) {
      clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    if (since) {
      clauses.push('occurred_at >= ?');
      params.push(since);
    }
    if (until) {
      clauses.push('occurred_at <= ?');
      params.push(until);
    }
    let rows;
    if (query && ftsTerms(query).length > 0) {
      const match = ftsTerms(query).map(ftsQuote).join(' OR ');
      try {
        rows = this.db
          .prepare(
            `SELECT e.*, bm25(events_fts) AS score FROM events_fts
             JOIN events e ON e.rowid = events_fts.rowid
             WHERE events_fts MATCH ? ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
             LIMIT 400`,
          )
          .all(match, ...params);
      } catch {
        rows = undefined;
      }
    }
    if (!rows) {
      rows = this.db
        .prepare(
          `SELECT e.*, 0 AS score FROM events e ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
           ORDER BY occurred_at DESC LIMIT 400`,
        )
        .all(...params);
    }
    let events = rows.map((r) => ({ row: r, event: rowToEvent(r) }));
    if (recencyDecay) {
      const now = Date.now();
      for (const entry of events) {
        const decay = computeRecencyDecay(entry.event.occurredAt, 'event', now);
        entry.row.score = (entry.row.score ?? 0) - Math.log(decay);
      }
      events.sort((a, b) => (a.row.score ?? 0) - (b.row.score ?? 0));
    }
    return events.slice(0, Math.max(1, limit)).map((x) => x.event);
  }

  get(eventKey) {
    const row = this.db.prepare('SELECT * FROM events WHERE event_key = ?').get(eventKey);
    return row ? rowToEvent(row) : null;
  }

  /** Commitments whose due time has passed and are still open (open loops). */
  dueOpenLoops(now = new Date().toISOString()) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE status = 'active' AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at",
      )
      .all(now)
      .map(rowToEvent);
  }

  stats() {
    const byKind = this.db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind').all();
    const tombstones = this.db.prepare('SELECT COUNT(*) AS n FROM event_tombstones').get().n;
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    return {
      total,
      byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
      tombstones,
      openLoops: this.dueOpenLoops().length,
    };
  }
}
