import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../src/store.js';
import { indexRoot } from '../src/scanner.js';
import { HashEmbedding } from '../src/embedding.js';
import { computeRecencyDecay } from '../src/util.js';

const dir = await mkdtemp(join(tmpdir(), 'diag-decay-'));
const fixtures = join(dir, 'knowledge');
await cp(new URL('../test/fixtures', import.meta.url), fixtures, { recursive: true });
const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
await indexRoot(store, fixtures);
const lessons = join(fixtures, 'lessons');
await writeFile(join(lessons, 'lesson-fresh-topic.md'), '---\ntitle: "Zeta topic canonical answer"\nkind: lesson\nkeywords: "zeta, unique, topic"\n---\n\nFresh zeta unique topic lesson.\n', 'utf8');
await writeFile(join(lessons, 'lesson-stale-topic.md'), '---\ntitle: "Zeta topic canonical answer old"\nkind: lesson\nkeywords: "zeta, unique, topic"\n---\n\nStale zeta unique topic lesson.\n', 'utf8');
await indexRoot(store, fixtures);
store.db.prepare('UPDATE evidence_docs SET updated_at = ? WHERE anchor = ?').run(new Date(Date.now() - 400 * 86400000).toISOString(), 'lessons-lesson-stale-topic');

const fts = store.ftsCandidates('zeta unique topic');
console.log('fts order:', fts.map((i) => i.anchor));
const stale = store.getByAnchor('lessons-lesson-stale-topic');
const fresh = store.getByAnchor('lessons-lesson-fresh-topic');
console.log('decay stale:', computeRecencyDecay(stale.updatedAt, 'lesson'), 'fresh:', computeRecencyDecay(fresh.updatedAt, 'lesson'));
const { items, scores } = store.search({ query: 'zeta unique topic', limit: 2 });
console.log('result order:', items.map((i) => i.anchor), 'scores:', scores);
store.close();
await rm(dir, { recursive: true, force: true });
