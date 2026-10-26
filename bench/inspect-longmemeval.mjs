// Inspect LongMemEval oracle schema: keys, question types, one sample instance.
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('./data/longmemeval_oracle.json', import.meta.url), 'utf8'));
console.log('instances:', data.length);
console.log('keys:', Object.keys(data[0]).join(', '));

const types = {};
let sessionCounts = [];
let turnCounts = [];
for (const inst of data) {
  types[inst.question_type] = (types[inst.question_type] ?? 0) + 1;
  sessionCounts.push(inst.haystack_sessions.length);
  turnCounts.push(inst.haystack_sessions.reduce((n, s) => n + s.length, 0));
}
console.log('question types:', JSON.stringify(types, null, 0));
console.log('sessions/instance: min', Math.min(...sessionCounts), 'avg', Math.round(sessionCounts.reduce((a, b) => a + b) / sessionCounts.length), 'max', Math.max(...sessionCounts));
console.log('turns/instance: avg', Math.round(turnCounts.reduce((a, b) => a + b) / turnCounts.length), 'max', Math.max(...turnCounts));

const sample = data[0];
const s0 = sample.haystack_sessions[0][0];
console.log('session turn keys:', Object.keys(s0).join(', '));
console.log('--- sample (truncated) ---');
console.log(JSON.stringify({
  qid: sample.question_id,
  type: sample.question_type,
  question: sample.question.slice(0, 160),
  answer: String(sample.answer).slice(0, 120),
  qdate: sample.question_date,
  haystack_dates: (sample.haystack_dates ?? []).slice(0, 6),
  evidence_keys: Object.keys(sample).filter((k) => k.toLowerCase().includes('evid')),
  first_turn: { role: s0.role, content: String(s0.content).slice(0, 200), create: s0.create_time },
  n_sessions: sample.haystack_sessions.length,
}, null, 1));
