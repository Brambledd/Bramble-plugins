// @local/dsh-memory-lessons — candidate store (truth side, dedicated DB).
//
// Distillation pipeline transplanted from Clowder's DistillationService:
// nominate -> pending -> approve/reject -> materialize. The candidate queue
// is durable TRUTH-side state (not a derived index): it must survive index
// rebuilds, so it lives in its own SQLite file, separate from the evidence
// index. Approved lessons materialize as markdown files under the lessons
// root — files are the durable truth; everything else is projection.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lesson_candidates (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  lesson TEXT NOT NULL,
  context TEXT,
  redacted INTEGER NOT NULL DEFAULT 0,
  nominated_at TEXT NOT NULL,
  decided_at TEXT,
  materialized_path TEXT
);
CREATE TABLE IF NOT EXISTS lesson_slug_counter (
  slug TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);
`;

function slugify(title) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 48) || 'lesson'
  );
}

export class LessonCandidateStore {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  /** Insert a redacted nomination. Returns the pending candidate row. */
  nominate({ title, lesson, context, redacted }) {
    const id = `les-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO lesson_candidates (id, status, title, lesson, context, redacted, nominated_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(id, title, lesson, context ?? null, redacted ? 1 : 0, now);
    return this.get(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM lesson_candidates WHERE id = ?').get(id);
    return row ? this.map(row) : null;
  }

  listPending() {
    return this.db
      .prepare("SELECT * FROM lesson_candidates WHERE status = 'pending' ORDER BY nominated_at")
      .all()
      .map((r) => this.map(r));
  }

  stats() {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM lesson_candidates GROUP BY status')
      .all();
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /**
   * Approve and materialize: writes the lesson as a markdown file under
   * `lessonsRoot` (slug-disambiguated) and records the path. The file is the
   * durable truth; the evidence index picks it up on the next scan (the
   * plugin triggers an immediate rescan of the lessons root).
   * @returns the approved candidate plus `{filePath}`.
   */
  async approve(id, lessonsRoot) {
    const candidate = this.get(id);
    if (!candidate) return { error: 'not_found' };
    if (candidate.status !== 'pending') return { error: 'not_pending', status: candidate.status };
    await mkdir(lessonsRoot, { recursive: true });
    const base = slugify(candidate.title);
    this.db
      .prepare('INSERT INTO lesson_slug_counter (slug, n) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET n = n + 1')
      .run(base);
    const n = this.db.prepare('SELECT n FROM lesson_slug_counter WHERE slug = ?').get(base).n;
    const seq = n === 1 ? '' : `-${n}`;
    const fileName = `lesson-${base}${seq}.md`;
    const filePath = join(lessonsRoot, fileName);
    const frontmatter = [
      '---',
      `title: ${JSON.stringify(candidate.title)}`,
      'kind: lesson',
      'status: active',
      // Human-approved distilled rules outrank raw notes in ranking
      // (Generative Agents importance factor; bounded ×1.2 in the store).
      'importance: 5',
      `summary: ${JSON.stringify(firstSentence(candidate.lesson))}`,
      'keywords: lesson, distilled',
      '---',
      '',
      `# Lesson: ${candidate.title}`,
      '',
      candidate.lesson,
      '',
      '---',
      `_nominated ${candidate.nominated_at}; approved ${new Date().toISOString()} via dsh-memory-lessons candidate ${candidate.id}${candidate.redacted ? '; secrets redacted at nomination' : ''}_`,
      '',
    ].join('\n');
    await writeFile(filePath, frontmatter, 'utf8');
    this.db
      .prepare(
        "UPDATE lesson_candidates SET status = 'approved', decided_at = ?, materialized_path = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), filePath, id);
    return { candidate: this.get(id), filePath };
  }

  reject(id) {
    const candidate = this.get(id);
    if (!candidate) return { error: 'not_found' };
    if (candidate.status !== 'pending') return { error: 'not_pending', status: candidate.status };
    this.db
      .prepare("UPDATE lesson_candidates SET status = 'rejected', decided_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return { candidate: this.get(id) };
  }

  map(row) {
    return { ...row, redacted: row.redacted === 1 };
  }
}

function firstSentence(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  const m = t.match(/^[^.!?。！？]+[.!?。！？]?/);
  return (m ? m[0] : t).slice(0, 120);
}
