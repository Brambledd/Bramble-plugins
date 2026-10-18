// @local/dsh-memory-core — SQLite schema lifecycle for the evidence store.
//
// The evidence database is a DERIVED index: the durable truth lives in the
// source `.md` files under the configured roots. Following the DSH-native
// idiom of `dsh-session-query-sqlite`, an `application_id` guard protects
// unrelated databases, `user_version` carries the schema version, and an
// incompatible version resets the derived tables in place (they are always
// rebuildable from the sources).
import { DatabaseSync } from 'node:sqlite';

/** Schema version of the derived evidence index. Never reuse a number. */
export const EVIDENCE_SCHEMA_VERSION = 1;

/** Application id guarding this database family ('MEM1'). */
export const EVIDENCE_APPLICATION_ID = 0x4d454d31;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  title, summary, keywords,
  content=evidence_docs, content_rowid=rowid,
  tokenize='trigram'
);
`;

const TABLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence_docs (
  anchor TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  authority TEXT NOT NULL DEFAULT 'standard',
  title TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,
  source_path TEXT,
  source_hash TEXT,
  superseded_by TEXT,
  updated_at TEXT NOT NULL
);
`;

// The three FTS sync triggers. Written one statement at a time (the body
// contains semicolons, matching exec conventions).
const FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_ai AFTER INSERT ON evidence_docs BEGIN
  INSERT INTO evidence_fts(rowid, title, summary, keywords) VALUES (new.rowid, new.title, new.summary, new.keywords);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_ad AFTER DELETE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary, keywords) VALUES ('delete', old.rowid, old.title, old.summary, old.keywords);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_au AFTER UPDATE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary, keywords) VALUES ('delete', old.rowid, old.title, old.summary, old.keywords);
  INSERT INTO evidence_fts(rowid, title, summary, keywords) VALUES (new.rowid, new.title, new.summary, new.keywords);
END`,
];

const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS cue_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  family TEXT NOT NULL,
  source_anchor TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  terminal TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (owner, family, source_anchor, source_revision)
);
CREATE TABLE IF NOT EXISTS indexed_roots (
  root TEXT PRIMARY KEY,
  kind_hint TEXT
);
`;

const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
`;

function listUserTables(db) {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  return rows.map((r) => r.name);
}

function listUserTriggers(db) {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all();
  return rows.map((r) => r.name);
}

/**
 * Open (creating if needed) and initialize the evidence database.
 *
 * - A foreign database (different application_id) is rejected.
 * - A recognized database with a stale schema version is RESET in place:
 *   derived tables are dropped and recreated, because everything is
 *   rebuildable from the source roots.
 *
 * @param {string} path absolute file path, or ':memory:'.
 * @returns {{ db: DatabaseSync, reset: boolean }} the initialized handle and
 *   whether a schema-version reset occurred during this open.
 */
export function openEvidenceDatabase(path) {
  const db = new DatabaseSync(path);
  let reset = false;
  try {
    db.exec(PRAGMAS);
    const appId = Number(db.prepare('PRAGMA application_id').get().application_id);
    if (appId !== 0 && appId !== EVIDENCE_APPLICATION_ID) {
      throw new Error(
        `evidence database at "${path}" belongs to another application (application_id=${appId})`,
      );
    }
    const tables = listUserTables(db);
    if (appId === 0 && tables.length > 0) {
      throw new Error(`evidence database at "${path}" is not empty and not a recognized evidence index`);
    }
    if (appId === EVIDENCE_APPLICATION_ID) {
      const version = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (version > EVIDENCE_SCHEMA_VERSION) {
        // A newer version wrote this index; we do not know its layout. Reset.
        reset = true;
      } else if (version < EVIDENCE_SCHEMA_VERSION) {
        reset = true;
      }
      if (reset) dropAllDerived(db);
    }
    db.exec(`PRAGMA application_id = ${EVIDENCE_APPLICATION_ID};`);
    db.exec(`PRAGMA user_version = ${EVIDENCE_SCHEMA_VERSION};`);
    applySchema(db);
    return { db, reset };
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

function dropAllDerived(db) {
  for (const trigger of listUserTriggers(db)) {
    db.exec(`DROP TRIGGER IF EXISTS "${trigger}";`);
  }
  for (const table of listUserTables(db)) {
    db.exec(`DROP TABLE IF EXISTS "${table}";`);
  }
}

/** Create all derived tables (idempotent). */
export function applySchema(db) {
  db.exec(TABLES_SCHEMA);
  db.exec(FTS_SCHEMA);
  for (const stmt of FTS_TRIGGERS) db.exec(stmt);
  db.exec(LEDGER_SCHEMA);
}
