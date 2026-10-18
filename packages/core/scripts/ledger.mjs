import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('E:/ClowderAI/dsh-memory/dev/evidence.sqlite');
const rows = db
  .prepare(
    "SELECT family, source_anchor, terminal, recorded_at FROM cue_episodes WHERE family = 'decision' ORDER BY recorded_at",
  )
  .all();
console.log('decision-family rows:');
for (const r of rows) console.log(`  ${r.source_anchor} : ${r.terminal} @ ${r.recorded_at}`);
console.log('total decision cues presented:', rows.length);
