import { EvidenceStore } from '../src/store.js';
import { executeForget } from '../src/forget-service.js';
import { indexRoot } from '../src/scanner.js';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'dbg-gate-'));
const fixtures = join(dir, 'knowledge');
await cp(new URL('./fixtures', import.meta.url), fixtures, { recursive: true });
const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
await indexRoot(store, fixtures);

const item = store.getByAnchor('ADR-001');
console.log('ADR-001 title:', item.title);
console.log('ADR-001 summary:', item.summary);

const targets = ['node sqlite driver evidence store'];
const words = [...new Set(targets.flatMap((t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length > 2))];
console.log('seed words:', words);
const hay = `${item.title} ${item.summary}`.toLowerCase();
const docWords = [...new Set(hay.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))];
console.log('doc words:', docWords);
const covered = docWords.filter((w) => words.includes(w));
console.log('covered:', covered, '=', covered.length / docWords.length);

const search = store.search({ query: targets[0], limit: 10, includeInactive: true });
console.log('probe hits:', search.items.map((i) => i.anchor));

store.close();
await rm(dir, { recursive: true, force: true });
