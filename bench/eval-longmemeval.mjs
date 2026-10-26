// LongMemEval retrieval harness for bramble-memory.
//
// Protocol (mirrors the paper's retrieval-stage evaluation, arXiv:2410.10813):
//   per question -> build a fresh evidence store -> index the oracle haystack
//   -> retrieve with the question text -> score against answer_session_ids.
// Metrics: recall@1/3/5 (any gold session in top-k), MRR, per question type
// (five LongMemEval abilities; abstention lives only in the full set).
//
// Modes / ablations:
//   --mode session|turn   index granularity (LongMemEval's "value
//                         granularity" insight: turn notes vs session notes)
//   --vector on|off       attach the hash embedding backend (hybrid RRF lane)
//   --date-tokens on|off  index session dates as keyword tokens (feeds the
//                         time-aware boost; ablation for temporal-reasoning)
//   --limit N             first N instances (default 500)
//   --out results.json    write the full metric payload
//
// Usage: node eval-longmemeval.mjs [--limit 500] ...
import { readFileSync, writeFileSync } from 'node:fs';
import { EvidenceStore } from '../packages/core/src/store.js';
import { createEmbeddingBackend } from '../packages/core/src/embedding.js';
import { computeRevision } from '../packages/core/src/util.js';

// ---------------------------------------------------------------- CLI
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const MODE = flag('mode', 'session');
const VECTOR = flag('vector', 'off') === 'on';
const DATE_TOKENS = flag('date-tokens', 'on') === 'on';
const LIMIT = Number(flag('limit', '500'));
const DATASET = flag('data', 's'); // s | m | oracle
const OUT = flag('out', null);

// ---------------------------------------------------------------- data
const data = JSON.parse(
  readFileSync(new URL(`./data/longmemeval_${DATASET}.json`, import.meta.url), 'utf8'),
).slice(0, LIMIT);

// ---------------------------------------------------------------- helpers
function sessionDateToken(raw) {
  // "2023/04/10 (Mon) 17:50" -> "2023-04-10"
  const m = String(raw ?? '').match(/(\d{4})\/(\d{2})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function indexSession(store, inst, idx, session) {
  const anchor = `${inst.question_id}::${inst.haystack_session_ids[idx]}`;
  const dateToken = sessionDateToken(inst.haystack_dates?.[idx]);
  const keywords = [];
  if (DATE_TOKENS && dateToken) keywords.push(dateToken);
  if (MODE === 'session') {
    const summary = session.map((t) => `${t.role}: ${t.content}`).join('\n');
    store.upsert({
      anchor, kind: 'note', status: 'active', authority: 'standard',
      title: `Session ${idx} (${dateToken ?? 'undated'})`, summary, keywords,
      sourcePath: null, revision: computeRevision(summary), supersededBy: null,
    });
  } else {
    // turn mode: one note per turn, session-scoped anchor prefix for recall
    session.forEach((turn, t) => {
      const text = `${turn.role}: ${turn.content}`;
      store.upsert({
        anchor: `${anchor}::t${t}`, kind: 'note', status: 'active', authority: 'standard',
        title: `${turn.role} turn`, summary: text, keywords,
        sourcePath: null, revision: computeRevision(text), supersededBy: null,
      });
    });
  }
}

function belongsToGold(anchor, goldSet) {
  const sessionId = anchor.split('::').slice(0, 2).join('::');
  return goldSet.has(sessionId);
}

// ---------------------------------------------------------------- eval loop
const perType = {};
const t0 = Date.now();
let done = 0;

for (const inst of data) {
  const store = new EvidenceStore(':memory:');
  if (VECTOR) {
    store.attachEmbedding(createEmbeddingBackend({ enabled: true, backend: 'hash' }));
  }
  inst.haystack_sessions.forEach((session, idx) => indexSession(store, inst, idx, session));
  if (VECTOR) {
    // mirror the plugin's startup backfill (production default gate 2000):
    // without vector rows the lane is inert
    let guard = 0;
    while (guard++ < 50) {
      const { embedded } = await store.embedBackfill({ batchSize: 128, maxIndexedChars: 2000 });
      if (embedded === 0) break;
    }
  }

  const goldSet = new Set(
    (inst.answer_session_ids ?? []).map((id) => `${inst.question_id}::${id}`),
  );
  const { items } = store.search({ query: inst.question, limit: 10 });
  const sessionsRanked = [];
  let firstGoldRank = 0;
  items.forEach((item, rank) => {
    const sessionId = item.anchor.split('::').slice(0, 2).join('::');
    if (!sessionsRanked.includes(sessionId)) sessionsRanked.push(sessionId);
  });
  for (let rank = 0; rank < sessionsRanked.length; rank += 1) {
    if (goldSet.has(sessionsRanked[rank])) { firstGoldRank = rank + 1; break; }
  }

  const type = inst.question_type;
  const bucket = (perType[type] ??= { n: 0, hits: { 1: 0, 3: 0, 5: 0 }, mrr: 0 });
  bucket.n += 1;
  for (const k of [1, 3, 5]) if (firstGoldRank >= 1 && firstGoldRank <= k) bucket.hits[k] += 1;
  bucket.mrr += firstGoldRank > 0 ? 1 / firstGoldRank : 0;
  done += 1;
  store.close();
  if (done % 100 === 0) console.error(`  ... ${done}/${data.length}`);
}

// ---------------------------------------------------------------- report
function summarize(bucket) {
  return {
    n: bucket.n,
    recallAt1: +(bucket.hits[1] / bucket.n).toFixed(3),
    recallAt3: +(bucket.hits[3] / bucket.n).toFixed(3),
    recallAt5: +(bucket.hits[5] / bucket.n).toFixed(3),
    mrr: +(bucket.mrr / bucket.n).toFixed(3),
  };
}

const overall = { n: 0, hits: { 1: 0, 3: 0, 5: 0 }, mrr: 0 };
for (const bucket of Object.values(perType)) {
  overall.n += bucket.n;
  for (const k of [1, 3, 5]) overall.hits[k] += bucket.hits[k];
  overall.mrr += bucket.mrr;
}

const report = {
  config: { dataset: DATASET, mode: MODE, vector: VECTOR, dateTokens: DATE_TOKENS, limit: data.length },
  elapsedMs: Date.now() - t0,
  overall: summarize(overall),
  perType: Object.fromEntries(Object.entries(perType).sort().map(([k, v]) => [k, summarize(v)])),
};
console.log(JSON.stringify(report, null, 1));
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
