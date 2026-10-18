// Lesson pipeline tests: nominate (redaction) -> approve (materialize +
// immediate indexing) -> reject; slug disambiguation; pending listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonCandidateStore } from '../src/candidate-store.js';
import { redactSecrets } from '../src/redactor.js';

test('redactor masks api keys, emails, ips and hex blobs', () => {
  const input =
    'contact me at alice@example.com from 192.168.1.42 with sk-AbCdEf123456789012 and 5d41402abc4b2a76b9719d911017c592';
  const out = redactSecrets(input);
  assert.equal(out.redactions, 4);
  assert.ok(out.text.includes('[email]'));
  assert.ok(out.text.includes('[ip]'));
  assert.ok(out.text.includes('[api-key]'));
  assert.ok(out.text.includes('[hex-blob]'));
  assert.ok(!out.text.includes('alice@example.com'));
  assert.ok(!out.text.includes('sk-AbCdEf'));
  const clean = redactSecrets('no secrets here, just a plain lesson');
  assert.equal(clean.redactions, 0);
  assert.equal(clean.text, 'no secrets here, just a plain lesson');
});

test('nominate stores pending candidate; approve materializes file; reject keeps audit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-lessons-'));
  const store = new LessonCandidateStore(join(dir, 'lessons.sqlite'));
  const lessonsRoot = join(dir, 'knowledge', 'lessons');
  try {
    const c1 = store.nominate({
      title: 'Always fsync after rename',
      lesson: 'On POSIX, rename is atomic but the directory entry needs an fsync to be crash-durable.',
      context: 'from the atomic-write module',
      redacted: false,
    });
    assert.equal(c1.status, 'pending');
    assert.equal(store.listPending().length, 1);

    const approved = await store.approve(c1.id, lessonsRoot);
    assert.ok(!approved.error, `approve must succeed: ${JSON.stringify(approved)}`);
    assert.ok(existsSync(approved.filePath));
    const content = await readFile(approved.filePath, 'utf8');
    assert.match(content, /kind: lesson/);
    assert.match(content, /# Lesson: Always fsync after rename/);
    assert.match(content, /candidate les-/);
    assert.equal(approved.candidate.status, 'approved');
    assert.equal(store.listPending().length, 0);

    // double approve fails cleanly
    const again = await store.approve(c1.id, lessonsRoot);
    assert.equal(again.error, 'not_pending');

    // rejection keeps the audit row
    const c2 = store.nominate({
      title: 'Bad idea',
      lesson: 'Something the user does not want to keep at all.',
      context: null,
      redacted: false,
    });
    const rejected = store.reject(c2.id);
    assert.equal(rejected.candidate.status, 'rejected');
    assert.equal(store.stats().rejected, 1);
    const missing = store.reject('les-nonexist');
    assert.equal(missing.error, 'not_found');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('same-title lessons get disambiguated filenames', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-lessons-slug-'));
  const store = new LessonCandidateStore(join(dir, 'lessons.sqlite'));
  const lessonsRoot = join(dir, 'lessons');
  try {
    const a = store.nominate({ title: 'Prefer idempotent writes', lesson: 'Make retries safe by keying on a stable coordinate.', context: null, redacted: false });
    const b = store.nominate({ title: 'Prefer idempotent writes', lesson: 'Make retries safe by keying on a stable coordinate (revised).', context: null, redacted: false });
    const fa = await store.approve(a.id, lessonsRoot);
    const fb = await store.approve(b.id, lessonsRoot);
    assert.notEqual(fa.filePath, fb.filePath);
    assert.match(fa.filePath, /lesson-prefer-idempotent-writes\.md$/);
    assert.match(fb.filePath, /lesson-prefer-idempotent-writes-2\.md$/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
