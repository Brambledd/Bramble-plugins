// Probe Zhipu embeddings endpoint (embedding-3).
import { readFileSync } from 'node:fs';
const raw = readFileSync('E:/ClowderAI/bemula-benchmark/.env', 'utf8');
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m) env[m[1]] = m[2];
}
const base = raw.match(/OPENAI_BASE_URL=(\S+)/)?.[1];
const res = await fetch(`${base}/embeddings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
  body: JSON.stringify({ model: env.BEMULA_EMBED_MODEL ?? 'embedding-3', input: ['用户喜欢在周末骑行', 'responsive web design in react'] }),
  signal: AbortSignal.timeout(30_000),
});
console.log('status:', res.status);
const body = await res.json();
if (body.data) {
  console.log('dims:', body.data.map((d) => d.embedding.length).join(','));
  console.log('sample[0..4]:', body.data[0].embedding.slice(0, 4));
} else {
  console.log(JSON.stringify(body).slice(0, 300));
}
