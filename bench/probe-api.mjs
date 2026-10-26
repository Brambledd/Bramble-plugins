// Probe the GLM endpoint: connectivity + a tiny completion (thinking off).
import { readFileSync } from 'node:fs';
const env = {};
const raw = readFileSync('E:/ClowderAI/bemula-benchmark/.env', 'utf8');
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m) env[m[1]] = m[2];
}
const urlMatch = raw.match(/OPENAI_BASE_URL=(\S+)/);
const base = urlMatch ? urlMatch[1] : env.OPENAI_BASE_URL;
const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
  body: JSON.stringify({
    model: env.BEMULA_AGENT_MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: 512,
    temperature: 0,
    thinking: { type: 'disabled' },
  }),
  signal: AbortSignal.timeout(60_000),
});
console.log('status:', res.status);
const body = await res.json();
console.log('content:', JSON.stringify(body.choices?.[0]?.message?.content ?? body));
console.log('usage:', JSON.stringify(body.usage ?? {}));
