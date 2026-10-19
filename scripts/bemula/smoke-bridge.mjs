// Offline smoke for the bemula bridge: observe -> search -> remove -> search.
import { spawn } from 'node:child_process';

const proc = spawn('node', ['E:/ClowderAI/Bramble-plugins/scripts/bemula/bridge.mjs'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const rl = (await import('node:readline')).createInterface({ input: proc.stdout });
let pending = null;
rl.on('line', (line) => {
  if (pending) {
    pending(JSON.parse(line));
    pending = null;
  }
});
const call = (payload) =>
  new Promise((resolve) => {
    pending = resolve;
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  });

console.log('reset:', await call({ op: 'reset' }));
console.log(
  'observe 1:',
  await call({ op: 'observe', speaker: 'user', text: 'I moved to Seattle last month, my new address is on Pine Street.', timestamp: '2026-01-10T10:00:00Z', sessionId: 's1', turnIndex: 0 }),
);
console.log(
  'observe 2:',
  await call({ op: 'observe', speaker: 'user', text: 'My daughter Lena started piano lessons every Tuesday.', timestamp: '2026-01-10T10:02:00Z', sessionId: 's1', turnIndex: 1 }),
);
console.log(
  'observe 3:',
  await call({ op: 'observe', speaker: 'user', text: 'I also switched jobs, now working at Nordic Labs as a data engineer.', timestamp: '2026-01-10T10:04:00Z', sessionId: 's1', turnIndex: 2 }),
);
const hits = await call({ op: 'search', query: 'where do I live address', limit: 5 });
console.log('search "address":', JSON.stringify(hits.results.map((r) => r.anchor)));
const hits2 = await call({ op: 'search', query: 'daughter lessons', limit: 5 });
console.log('search "daughter":', JSON.stringify(hits2.results.map((r) => r.anchor)));
const removed = await call({ op: 'remove', anchors: [hits.results[0].anchor] });
console.log('remove:', removed);
const after = await call({ op: 'search', query: 'where do I live address Seattle', limit: 10 });
console.log('search after remove:', JSON.stringify(after.results.map((r) => r.anchor)));
console.log('preserved daughter still found:', JSON.stringify((await call({ op: 'search', query: 'piano Tuesday Lena', limit: 5 })).results.map((r) => r.anchor)));
proc.stdin.end();
