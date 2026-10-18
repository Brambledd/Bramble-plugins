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
  const anchors = [];
  for await (const filePath of walk(absRoot)) {
    scanned += 1;
    const content = await readFile(filePath, 'utf8');
    const revision = computeRevision(content);
    const relativePath = relative(absRoot, filePath);
    const frontmatter = parseFrontmatter(content);
    const kind = inferKind({ relativePath, frontmatter, kindHint });
    const anchor = deriveAnchor({ frontmatter, relativePath, revision });
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
    };
    const result = store.upsert(item);
    if (result.updated) updated += 1;
    else unchanged += 1;
    anchors.push(anchor);
  }
  return { scanned, updated, unchanged, anchors };
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
