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
const EMBED_API = flag('embedder', 'off') === 'api'; // Zhipu embedding-3 real embeddings
const EMBED_TRUNC = Number(flag('embed-trunc', '4000'));
const LIMIT = Number(flag('limit', '500'));
const DATASET = flag('data', 's'); // s | m | s_cleaned | oracle
const OUT = flag('out', null);

// bemula .env (API credentials for the optional real-embedding backend)
const ENV_RAW = EMBED_API ? readFileSync('E:/ClowderAI/bemula-benchmark/.env', 'utf8') : '';
const ENV = {};
if (EMBED_API) for (const line of ENV_RAW.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/); if (m) ENV[m[1]] = m[2]; }
const API_BASE = EMBED_API ? ENV_RAW.match(/OPENAI_BASE_URL=(\S+)/)?.[1] : null;

function apiEmbedder() {
  const model = ENV.BEMULA_EMBED_MODEL ?? 'embedding-3';
  return {
    model,
    async embed(texts) {
      const out = new Array(texts.length);
      // sanitizer: control chars and lone surrogates trip Zhipu 1210
      const clean = (t) => t
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
        .replace(/[\uD800-\uDFFF]/g, '')
        .trim();
      // send one text, halving its LENGTH on 400 (some texts exceed the
      // model's input-token budget even under EMBED_TRUNC chars); gives up
      // below 200 chars and leaves the slot undefined (skipped by backfill)
      const sendOne = async (text, slot, offset, depth = 0) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            const res = await fetch(`${API_BASE}/embeddings`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${ENV.OPENAI_API_KEY}` },
              body: JSON.stringify({ model, input: [text] }),
              signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) {
              if (res.status === 400 && text.length > 200 && depth < 6) {
                await sendOne(text.slice(0, Math.floor(text.length / 2)), slot, offset, depth + 1);
                return;
              }
              const bodyText = await res.text().catch(() => '');
              throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
            }
            const body = await res.json();
            out[offset + body.data[0].index] = Float32Array.from(body.data[0].embedding);
            return;
          } catch (error) {
            const halvable = text.length > 200 && depth < 6;
            if (error.message.startsWith('HTTP 400') && halvable) {
              await sendOne(text.slice(0, Math.floor(text.length / 2)), slot, offset, depth + 1);
              return;
            }
            if (attempt >= 2) {
              console.error(`  embed skip (${String(slot + 1)}/${texts.length}): ${error.message.slice(0, 120)}`);
              return; // leave slot undefined — backfill skips null vectors
            }
            await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
          }
        }
      };
      // adaptive batch: 1210 on over-long BATCHES — halve recursively
      const send = async (batch, offset) => {
        if (batch.length > 1) {
          for (let attempt = 0; ; attempt += 1) {
            try {
              const res = await fetch(`${API_BASE}/embeddings`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${ENV.OPENAI_API_KEY}` },
                body: JSON.stringify({ model, input: batch }),
                signal: AbortSignal.timeout(120_000),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const body = await res.json();
              for (const d of body.data.slice().sort((a, b) => a.index - b.index)) {
                out[offset + d.index] = Float32Array.from(d.embedding);
              }
              return;
            } catch {
              if (attempt >= 1) break; // fall through to per-item sends
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
          const mid = Math.floor(batch.length / 2);
          await send(batch.slice(0, mid), offset);
          await send(batch.slice(mid), offset + mid);
          return;
        }
        await sendOne(clean(batch[0] ?? ''), offset, 0);
      };
      for (let i = 0; i < texts.length; i += 16) {
        await send(texts.slice(i, i + 16).map((t) => t.slice(0, EMBED_TRUNC)), i);
      }
      // DENSE array with holes — embedBackfill matches vectors to rows by
      // index; compacting here would attach vectors to the wrong anchors.
      return out;
    },
  };
}

// ---------------------------------------------------------------- data
const DATA_FILES = { s: 'longmemeval_s.json', s_cleaned: 'longmemeval_s_cleaned.json', oracle: 'longmemeval_oracle.json' };
const data = JSON.parse(
  readFileSync(new URL(`./data/${DATA_FILES[DATASET] ?? `longmemeval_${DATASET}.json`}`, import.meta.url), 'utf8'),
)
  // official retrieval protocol skips the 30 abstention instances (no gold location)
  .filter((inst) => !inst.question_id.endsWith('_abs'))
  .slice(0, LIMIT);

// ---------------------------------------------------------------- helpers
function sessionDateToken(raw) {
  // "2023/04/10 (Mon) 17:50" -> "2023-04-10"
  const m = String(raw ?? '').match(/(\d{4})\/(\d{2})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function indexSession(store, inst, idx, session) {
  if (MODE === 'session') {
    const summary = session.map((t) => `${t.role}: ${t.content}`).join('\n');
    if (!summary.trim()) return; // empty placeholder sessions: nothing to index
    const anchor = `${inst.question_id}::${inst.haystack_session_ids[idx]}`;
    const dateToken = sessionDateToken(inst.haystack_dates?.[idx]);
    const keywords = [];
    if (DATE_TOKENS && dateToken) keywords.push(dateToken);
    store.upsert({
      anchor, kind: 'note', status: 'active', authority: 'standard',
      title: `Session ${idx} (${dateToken ?? 'undated'})`, summary, keywords,
      sourcePath: null, revision: computeRevision(summary), supersededBy: null,
    });
  } else {
    // turn mode: one note per turn, session-scoped anchor prefix for recall
    const anchor = `${inst.question_id}::${inst.haystack_session_ids[idx]}`;
    const dateToken = sessionDateToken(inst.haystack_dates?.[idx]);
    const keywords = [];
    if (DATE_TOKENS && dateToken) keywords.push(dateToken);
    session.forEach((turn, t) => {
      const text = `${turn.role}: ${turn.content}`;
      if (!text.trim()) return;
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
  if (EMBED_API) {
    store.attachEmbedding(apiEmbedder());
  }
  inst.haystack_sessions.forEach((session, idx) => indexSession(store, inst, idx, session));
  if (VECTOR || EMBED_API) {
    // mirror the plugin's startup backfill (gate 8000 for real embeddings —
    // quality argument no longer applies, only the embedding-context cap)
    let guard = 0;
    while (guard++ < 80) {
      const { embedded } = await store.embedBackfill({ batchSize: VECTOR ? 128 : 16, maxIndexedChars: EMBED_API ? 8000 : 2000 });
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
