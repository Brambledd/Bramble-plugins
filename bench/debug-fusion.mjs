import { readFileSync } from 'node:fs';
import { EvidenceStore } from '../packages/core/src/store.js';
import { createEmbeddingBackend } from '../packages/core/src/embedding.js';
import { computeRevision } from '../packages/core/src/util.js';

const data = JSON.parse(readFileSync(new URL('./data/longmemeval_s.json', import.meta.url), 'utf8')).slice(0, 3);
const dateTok = (raw) => { const m = String(raw ?? '').match(/(\d{4})\/(\d{2})\/(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };

for (const inst of data) {
  for (const withVec of [false, true]) {
    const store = new EvidenceStore(':memory:');
    if (withVec) store.attachEmbedding(createEmbeddingBackend({ enabled: true, backend: 'hash' }));
    inst.haystack_sessions.forEach((session, idx) => {
      const anchor = `${inst.question_id}::${inst.haystack_session_ids[idx]}`;
      const kw = [];
      const dt = dateTok(inst.haystack_dates?.[idx]);
      if (dt) kw.push(dt);
      const summary = session.map((t) => `${t.role}: ${t.content}`).join('\n');
      store.upsert({ anchor, kind: 'note', status: 'active', authority: 'standard', title: `S${idx}`, summary, keywords: kw, sourcePath: null, revision: computeRevision(summary), supersededBy: null });
    });
    if (withVec) for (let i = 0; i < 20; i += 1) { const r = await store.embedBackfill({ batchSize: 128, maxIndexedChars: 2000 }); if (r.embedded === 0) break; }
    const { items, scores, matchMode } = store.search({ query: inst.question, limit: 5 });
    const gold = new Set(inst.answer_session_ids);
    console.log(withVec ? 'VEC' : 'BM25', '| mode:', matchMode, '| gold:', [...gold][0] ?? 'none');
    items.forEach((it, i) => {
      const sid = it.anchor.split('::')[1];
      console.log(`  #${i + 1} score=${scores[i].toFixed(5)} len=${(it.summary ?? '').length} ${gold.has(sid) ? 'GOLD' : '    '} ${sid.slice(0, 20)}`);
    });
    store.close();
  }
  console.log('---');
}
