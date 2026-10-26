// @local/dsh-memory-core — source scanner: truth side of the evidence split.
//
// Walks configured roots for `*.md`, derives kind/anchor/metadata from the
// path and frontmatter (no LLM involvement — deterministic, like Clowder's
// scanners), computes the content revision, and upserts into the store.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  computeRevision,
  parseFrontmatter,
  parseKeywords,
  deriveAnchor,
  EVIDENCE_KINDS,
} from './util.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh', 'dist', 'build', '.pnpm']);

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      yield full;
    }
  }
}

function inferKind({ relativePath, frontmatter, kindHint }) {
  const explicit = frontmatter.kind;
  if (explicit && EVIDENCE_KINDS.includes(explicit)) return explicit;
  const normalized = relativePath.replace(/\\/g, '/');
  if (/^decisions\//.test(normalized) || /ADR-\d+/i.test(normalized)) return 'decision';
  if (/^lessons\//.test(normalized)) return 'lesson';
  if (/^events?\//.test(normalized)) return 'event';
  if (/^people\//.test(normalized)) return 'person';
  if (/^projects\//.test(normalized)) return 'project';
  if (kindHint && EVIDENCE_KINDS.includes(kindHint)) return kindHint;
  return 'note';
}

function deriveTitle({ frontmatter, content, relativePath }) {
  if (frontmatter.title && frontmatter.title.trim().length > 0) return frontmatter.title.trim();
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return relativePath;
}

function inferStatus({ frontmatter, kind }) {
  const explicit = frontmatter.status;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  if (kind === 'decision') {
    // Decision records without an explicit status are NOT treated as
    // accepted (fail closed — Clowder decision semantics).
    return 'captured';
  }
  return 'active';
}

/** Soft-deleted files (status: deleted) are skipped by the scanner and their
 *  index rows are removed on rescan — the file is preserved for audit but
 *  never resurfaces in search or cues. */
function isSoftDeleted(frontmatter) {
  return frontmatter.status === 'deleted';
}

/**
 * Scan one root and upsert every discovered document.
 * @param {import('./store.js').EvidenceStore} store
 * @returns {Promise<{scanned:number, updated:number, unchanged:number, anchors:string[]}>}
 */
export async function indexRoot(store, rootDir, { kindHint = null } = {}) {
  const absRoot = resolve(rootDir);
  store.rememberRoot(absRoot, kindHint);
  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let softDeleted = 0;
  const anchors = [];
  for await (const filePath of walk(absRoot)) {
    scanned += 1;
    const content = await readFile(filePath, 'utf8');
    const revision = computeRevision(content);
    const relativePath = relative(absRoot, filePath);
    const frontmatter = parseFrontmatter(content);
    // Soft-deleted files are skipped: no index upsert, and their existing
    // index rows (if any) will be cleaned up by the orphan sweep below.
    if (isSoftDeleted(frontmatter)) {
      softDeleted += 1;
      continue;
    }
    const kind = inferKind({ relativePath, frontmatter, kindHint });
    const anchor = deriveAnchor({ frontmatter, relativePath, revision });
    // Frontmatter importance 1-5 (Generative Agents rating); lessons
    // materialize with 5, everything else defaults to 1.
    const importanceNum = Number(frontmatter.importance);
    const importance =
      Number.isFinite(importanceNum) && importanceNum >= 1
        ? Math.min(5, Math.round(importanceNum))
        : 1;
    const item = {
      anchor,
      kind,
      status: inferStatus({ frontmatter, kind }),
      authority: frontmatter.authority && frontmatter.authority.trim().length > 0 ? frontmatter.authority.trim() : 'standard',
      title: deriveTitle({ frontmatter, content, relativePath }),
      summary: frontmatter.summary && frontmatter.summary.trim().length > 0 ? frontmatter.summary.trim() : null,
      keywords: parseKeywords(frontmatter.keywords),
      sourcePath: filePath,
      revision,
      supersededBy: null,
      importance,
    };
    const result = store.upsert(item);
    if (result.updated) updated += 1;
    else unchanged += 1;
    anchors.push(anchor);
  }
  const removed = removeOrphans(store, absRoot, new Set(anchors));
  return { scanned, updated, unchanged, softDeleted, removed, anchors };
}

/**
 * Delete happens by removing the source file — the scanner must then drop
 * the orphaned index rows, or deleted memories keep leaking titles and
 * summaries through memory_search. Only rows whose source_path lives under
 * THIS root are eligible (other roots and anchor-less rows are untouched).
 * Cue-ledger rows survive: they record behavior (anchor + revision), never
 * content.
 * @returns {string[]} removed anchors
 */
function removeOrphans(store, absRoot, seenAnchors) {
  const prefix = `${absRoot.replace(/\\/g, '/')}/`;
  const rows = store.db
    .prepare('SELECT anchor, source_path FROM evidence_docs WHERE source_path IS NOT NULL')
    .all();
  const removed = [];
  for (const row of rows) {
    const sourcePath = String(row.source_path).replace(/\\/g, '/');
    if (!sourcePath.startsWith(prefix)) continue;
    if (seenAnchors.has(row.anchor)) continue;
    store.removeByAnchor(row.anchor);
    removed.push(row.anchor);
  }
  return removed;
}

/**
 * Full rebuild: wipe the derived document index, then rescan every
 * remembered root. The cue ledger is intentionally preserved (consumption
 * history is behavioral truth, not derived content).
 */
export async function rebuildAll(store) {
  store.wipe();
  const roots = store.listRoots();
  let total = { scanned: 0, updated: 0, unchanged: 0, anchors: [] };
  for (const { root, kind_hint } of roots) {
    const result = await indexRoot(store, root, { kindHint: kind_hint });
    total = {
      scanned: total.scanned + result.scanned,
      updated: total.updated + result.updated,
      unchanged: total.unchanged + result.unchanged,
      anchors: [...total.anchors, ...result.anchors],
    };
  }
  return total;
}
