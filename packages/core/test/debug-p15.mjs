// Reproduce P0015: F3 social forget → marker → relearning "walking group"
// → does supersedeRetractionsForText flip the marker?
import { EvidenceStore } from '../src/store.js';
import { executeForget, supersedeRetractionsForText } from '../src/forget-service.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'dbg-p15-'));
const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
const STALE = new Date(Date.now() - 3_600_000).toISOString();

// P0015-like social entries (observed turns)
const socialTurns = [
  "I'm a member of the Crouch End library book group, we meet monthly.",
  'I usually meet my friend Priya for coffee after Saturday errands.',
  'My former nursing colleagues and I keep in touch on WhatsApp.',
];
socialTurns.forEach((t, i) => {
  store.upsert({
    anchor: `turn-s00${i + 1}`, kind: 'note', status: 'active', authority: 'standard',
    title: t.slice(0, 117), summary: t,
    keywords: [...t.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1).slice(0, 20), '2025-0' + (i + 3) + '-1' + i],
    sourcePath: null, revision: 'r' + i, supersededBy: null,
    updatedAt: `2025-0${i + 3}-10T10:00:00Z`,
  });
});

const FORGET_TS = '2026-10-05T10:00:00Z';
const result = await executeForget(store, {
  scope: 'topic',
  targets: ['social life', 'personal social details', 'keep my social life private'],
  freshAfter: FORGET_TS,
});
console.log('forget:', { removed: result.removed, retractionMarker: result.retractionMarker });

const marker = store.search({ query: 'social life', limit: 5, includeInactive: true }).items.find((i) => i.kind === 'retraction');
console.log('marker keywords:', marker?.keywords);

// relearning turn observed AFTER the forget
const obs = store.upsert({
  anchor: 'turn-relearn', kind: 'note', status: 'active', authority: 'standard',
  title: "I've joined a weekend walking group in Highgate",
  summary: "I've joined a weekend walking group in Highgate",
  keywords: ['joined', 'weekend', 'walking', 'group', 'highgate', '2026-10-15'],
  sourcePath: null, revision: 'rx', supersededBy: null,
  updatedAt: '2026-10-15T09:00:00Z',
});
const superseded = supersedeRetractionsForText(store, "I've joined a weekend walking group in Highgate", 'turn-relearn');
console.log('superseded:', superseded);
console.log('marker status after:', store.getByAnchor(marker.anchor).status);
store.close();
await rm(dir, { recursive: true, force: true });
