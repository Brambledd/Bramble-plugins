// Build the reader-QA sample: stratified 10 questions per type from the S
// set, each with top-3 retrieved session contexts (session mode, BM25, the
// measured-best config). Output: bench/results/qa-sample.jsonl
import { readFileSync, writeFileSync } from 'node:fs';
import { EvidenceStore } from '../packages/core/src/store.js';
import { computeRevision } from '../packages/core/src/util.js';

const data = JSON.parse(readFileSync(new URL('./data/longmemeval_s.json', import.meta.url), 'utf8'));
const PER_TYPE = 10;
const seen = {};
const sample = [];
for (const inst of data) {
  seen[inst.question_type] = (seen[inst.question_type] ?? 0) + 1;
  if (seen[inst.question_type] <= PER_TYPE) sample.push(inst);
  if (Object.values(seen).every((n) => n >= PER_TYPE) && Object.keys(seen).length === 6) break;
}

const lines = [];
for (const inst of sample) {
  const store = new EvidenceStore(':memory:');
  const contexts = [];
  inst.haystack_sessions.forEach((session, idx) => {
    const anchor = `${inst.question_id}::${inst.haystack_session_ids[idx]}`;
    const summary = session.map((t) => `${t.role}: ${t.content}`).join('\n');
    store.upsert({ anchor, kind: 'note', status: 'active', authority: 'standard', title: `S${idx}`, summary, keywords: [], sourcePath: null, revision: computeRevision(summary), supersededBy: null });
  });
  const { items } = store.search({ query: inst.question, limit: 3 });
  const byAnchor = new Map();
  inst.haystack_sessions.forEach((session, idx) => {
    byAnchor.set(`${inst.question_id}::${inst.haystack_session_ids[idx]}`, session);
  });
  for (const item of items.slice(0, 3)) {
    const session = byAnchor.get(item.anchor);
    if (!session) continue;
    const text = session.map((t) => `${t.role}: ${t.content}`).join('\n').slice(0, 14_000);
    contexts.push(`[Session ${item.anchor.split('::')[1]}]\n${text}`);
  }
  store.close();
  lines.push(JSON.stringify({
    qid: inst.question_id,
    type: inst.question_type,
    question: inst.question,
    gold: inst.answer,
    retrieved: contexts.length,
    hitTop3: items.some((i) => (inst.answer_session_ids ?? []).includes(i.anchor.split('::')[1])),
    context: contexts.join('\n\n'),
  }));
}
writeFileSync(new URL('./results/qa-sample.jsonl', import.meta.url), lines.join('\n'));
console.log(`wrote ${lines.length} samples`);
