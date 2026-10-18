#!/usr/bin/env node
// Operator script: scan roots into (or rebuild) a memory evidence index.
//
// Usage:
//   node scripts/reindex.mjs --db <path> --root <dir> [--root <dir2> ...]
//   node scripts/reindex.mjs --db <path> --rebuild
//   node scripts/reindex.mjs --db <path> --search "query terms"
//   node scripts/reindex.mjs --db <path> --stats
import { EvidenceStore } from '../src/store.js';
import { indexRoot, rebuildAll } from '../src/scanner.js';

function parseArgs(argv) {
  const out = { db: null, roots: [], rebuild: false, search: null, stats: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') out.db = argv[++i];
    else if (arg === '--root') out.roots.push(argv[++i]);
    else if (arg === '--rebuild') out.rebuild = true;
    else if (arg === '--search') out.search = argv[++i];
    else if (arg === '--stats') out.stats = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!out.db) {
    console.error('usage: reindex.mjs --db <path> (--root <dir> | --rebuild | --search <q> | --stats)');
    process.exit(2);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const store = new EvidenceStore(args.db);
try {
  if (store.resetOnOpen) {
    console.log(`note: stale schema detected; derived index was reset (schema v${store.schemaVersion}).`);
  }
  if (args.roots.length > 0) {
    for (const root of args.roots) {
      const result = await indexRoot(store, root);
      console.log(
        `indexed ${root}: scanned=${result.scanned} updated=${result.updated} unchanged=${result.unchanged}`,
      );
    }
  }
  if (args.rebuild) {
    const result = await rebuildAll(store);
    console.log(
      `rebuilt all roots: scanned=${result.scanned} updated=${result.updated} unchanged=${result.unchanged}`,
    );
  }
  if (args.search) {
    const { items, matchMode } = store.search({ query: args.search, limit: 10 });
    console.log(`search "${args.search}" [${matchMode ?? 'no-match'}]:`);
    for (const item of items) {
      const active = item.supersededBy || item.status !== 'active' && item.status !== 'accepted' ? ' [inactive]' : '';
      console.log(`  - ${item.anchor} (${item.kind}/${item.status}) ${item.title}${active}`);
    }
  }
  if (args.stats || (args.roots.length === 0 && !args.rebuild && !args.search)) {
    console.log(JSON.stringify(store.stats(), null, 2));
  }
} finally {
  store.close();
}
