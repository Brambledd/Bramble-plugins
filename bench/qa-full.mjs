// Full LongMemEval reader-QA evaluation with the OFFICIAL judge protocol
// (ported from LongMemEval src/evaluation/evaluate_qa.py, template-exact).
//
// Pipeline per instance: fresh evidence store -> index haystack sessions
// (session granularity, BM25 — the measured-best config) -> retrieve top-K
// -> reader LLM answers from context only -> judge LLM labels yes/no with
// the official per-type templates (temporal off-by-one leniency,
// knowledge-update updated-answer rule, preference rubric, abstention via
// `_abs` qid suffix).
//
// Resume-safe: reader answers and judge labels cache to jsonl files under
// the out dir; existing entries are skipped on rerun.
//
// Usage:
//   node qa-full.mjs --data s --limit 500 --concurrency 8
//   node qa-full.mjs --data s_cleaned --limit 500
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, openSync, readSync } from 'node:fs';
import { EvidenceStore } from '../packages/core/src/store.js';
import { computeRevision } from '../packages/core/src/util.js';

// ------------------------------------------------------------------ env
const ENV_PATH = 'E:/ClowderAI/bemula-benchmark/.env';
const rawEnv = readFileSync(ENV_PATH, 'utf8');
const env = {};
for (const line of rawEnv.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m) env[m[1]] = m[2];
}
const BASE = rawEnv.match(/OPENAI_BASE_URL=(\S+)/)?.[1] ?? env.OPENAI_BASE_URL;
const KEY = env.OPENAI_API_KEY;
const READER_MODEL = env.BEMULA_AGENT_MODEL ?? 'glm-5.3';
const JUDGE_MODEL = env.BEMULA_JUDGE_MODEL ?? READER_MODEL;
const TIMEOUT = Number(env.OPENAI_TIMEOUT_MS ?? 60_000);

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const DATASET = flag('data', 's');
const LIMIT = Number(flag('limit', '500'));
const CONCURRENCY = Number(flag('concurrency', '8'));
const TOPK = Number(flag('topk', '3'));
const TRUNC = Number(flag('trunc', '12000'));
const OUT_DIR = flag('out', `results/qa-${DATASET}`);

const DATA_FILES = {
  s: 'longmemeval_s.json',
  s_cleaned: 'longmemeval_s_cleaned.json',
  oracle: 'longmemeval_oracle.json',
};
const dataFile = DATA_FILES[DATASET] ?? `longmemeval_${DATASET}.json`;
const data = JSON.parse(readFileSync(new URL(`./data/${dataFile}`, import.meta.url), 'utf8')).slice(0, LIMIT);

mkdirSync(OUT_DIR, { recursive: true });

// ------------------------------------------------------------------ cache
function loadCache(file) {
  const path = `${OUT_DIR}/${file}`;
  const map = new Map();
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); map.set(o.qid, o); } catch {}
    }
  }
  return {
    map,
    add(obj) {
      map.set(obj.qid, obj);
      appendFileSync(path, JSON.stringify(obj) + '\n');
    },
  };
}
const readerCache = loadCache('reader.jsonl');
const judgeCache = loadCache('judge.jsonl');

// ------------------------------------------------------------------ LLM
async function chat(model, messages, { maxTokens = 512, temperature = 0 } = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, thinking: { type: 'disabled' } }),
    signal: AbortSignal.timeout(TIMEOUT * 2),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.choices?.[0]?.message?.content?.trim() ?? '';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function chatRetry(model, messages, opts, retries = 2) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chat(model, messages, opts);
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(1500 * 2 ** attempt);
    }
  }
}

// ------------------------------------------------------- official judge
function ansCheckPrompt(task, question, answer, response, abstention) {
  if (!abstention) {
    if (task === 'temporal-reasoning') {
      return "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: " + question + "\n\nCorrect Answer: " + answer + "\n\nModel Response: " + response + "\n\nIs the model response correct? Answer yes or no only.";
    }
    if (task === 'knowledge-update') {
      return "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: " + question + "\n\nCorrect Answer: " + answer + "\n\nModel Response: " + response + "\n\nIs the model response correct? Answer yes or no only.";
    }
    if (task === 'single-session-preference') {
      return "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: " + question + "\n\nRubric: " + answer + "\n\nModel Response: " + response + "\n\nIs the model response correct? Answer yes or no only.";
    }
    // single-session-user / single-session-assistant / multi-session
    return "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: " + question + "\n\nCorrect Answer: " + answer + "\n\nModel Response: " + response + "\n\nIs the model response correct? Answer yes or no only.";
  }
  return "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: " + question + "\n\nExplanation: " + answer + "\n\nModel Response: " + response + "\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.";
}

// ------------------------------------------------------------- retrieval
function retrieveTopK(inst) {
  const store = new EvidenceStore(':memory:');
  const byAnchor = new Map();
  inst.haystack_sessions.forEach((session, idx) => {
    const anchor = `${inst.question_id}::${inst.haystack_session_ids[idx]}`;
    const summary = session.map((t) => `${t.role}: ${t.content}`).join('\n');
    store.upsert({ anchor, kind: 'note', status: 'active', authority: 'standard', title: `S${idx}`, summary, keywords: [], sourcePath: null, revision: computeRevision(summary), supersededBy: null });
    byAnchor.set(anchor, summary);
  });
  const { items } = store.search({ query: inst.question, limit: TOPK });
  store.close();
  return items
    .map((i) => byAnchor.get(i.anchor))
    .filter(Boolean)
    .map((s) => s.slice(0, TRUNC));
}

// ------------------------------------------------------------ worker pool
async function pool(items, worker, size = CONCURRENCY) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// ----------------------------------------------------------------- main
console.error(`qa-full: dataset=${DATASET} instances=${data.length} concurrency=${CONCURRENCY} model=${READER_MODEL}`);
const t0 = Date.now();
let done = 0;

await pool(data, async (inst) => {
  const isAbs = inst.question_id.endsWith('_abs');
  // ---- reader
  let hyp = readerCache.map.get(inst.question_id)?.hypothesis;
  if (hyp === undefined) {
    const contexts = retrieveTopK(inst);
    const prompt = contexts.length > 0
      ? `The following are excerpts from the user's chat history with an assistant.\n\n---\n${contexts.join('\n\n---\n\n')}\n---\n\nQuestion: ${inst.question}\n\nAnswer the question based only on the chat history above. If the history does not contain enough information to answer, say you don't know.`
      : `Question: ${inst.question}\n\nNo chat history is available. Say you don't know.`;
    hyp = await chatRetry(READER_MODEL, [{ role: 'user', content: prompt }], { maxTokens: 512, temperature: 0 });
    readerCache.add({ qid: inst.question_id, hypothesis: hyp });
  }
  // ---- judge (official template)
  let label = judgeCache.map.get(inst.question_id)?.label;
  if (label === undefined) {
    const jPrompt = ansCheckPrompt(inst.question_type, inst.question, inst.answer, hyp, isAbs);
    const verdict = (await chatRetry(JUDGE_MODEL, [{ role: 'user', content: jPrompt }], { maxTokens: 10, temperature: 0 })).toLowerCase();
    label = verdict.includes('yes');
    judgeCache.add({ qid: inst.question_id, label });
  }
  done += 1;
  if (done % 25 === 0) console.error(`  ... ${done}/${data.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
});

// ---------------------------------------------------------------- report
const perType = {};
const abs = { n: 0, ok: 0 };
let n = 0, ok = 0;
for (const inst of data) {
  const j = judgeCache.map.get(inst.question_id);
  if (!j) continue;
  const isAbs = inst.question_id.endsWith('_abs');
  n += 1; ok += j.label ? 1 : 0;
  if (isAbs) { abs.n += 1; abs.ok += j.label ? 1 : 0; }
  const b = (perType[inst.question_type] ??= { n: 0, ok: 0 });
  b.n += 1; b.ok += j.label ? 1 : 0;
}
const report = {
  config: { dataset: DATASET, n, reader: READER_MODEL, judge: JUDGE_MODEL, topk: TOPK, trunc: TRUNC, elapsedMin: +((Date.now() - t0) / 60000).toFixed(1) },
  accuracy: +(ok / n).toFixed(4),
  abstention: abs.n > 0 ? { n: abs.n, accuracy: +(abs.ok / abs.n).toFixed(4) } : null,
  perType: Object.fromEntries(Object.entries(perType).sort().map(([k, v]) => [k, { n: v.n, accuracy: +(v.ok / v.n).toFixed(4) }])),
};
console.log(JSON.stringify(report, null, 1));
writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 1));
