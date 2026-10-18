// Plugin-level test: the full nomination 鈫?approve 鈫?searchable-in-evidence
// loop runs against a stub Cordis context with real fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { EvidenceStore } from '../../core/src/store.js';
import { indexRoot } from '../../core/src/scanner.js';

function makeStubCtx() {
  const tools = [];
  const sections = [];
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: (t) => { tools.push(t); return () => {}; } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    effect(fn) {
      const d = fn();
      disposers.push(typeof d === 'function' ? d : () => {});
      return () => {};
    },
  };
  return { ctx, tools, sections, disposers };
}

test('nominate 鈫?approve 鈫?materialized lesson is immediately searchable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-lessons-plugin-'));
  const knowledge = join(dir, 'knowledge');
  const lessonsRoot = join(knowledge, 'lessons');
  await cp(new URL('../../core/test/fixtures', import.meta.url), knowledge, { recursive: true });
  {
    const evidence = new EvidenceStore(join(dir, 'evidence.sqlite'));
    await indexRoot(evidence, knowledge);
    evidence.close();
  }
  const { ctx, tools, disposers } = makeStubCtx();
  apply(ctx, {
    dbPath: join(dir, 'lessons.sqlite'),
    lessonsRoot,
    evidenceDbPath: join(dir, 'evidence.sqlite'),
    evidenceRoot: knowledge,
  });
  try {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['lesson_nominate', 'lesson_approve', 'lesson_reject', 'lesson_pending']) {
      assert.ok(byName[n], `${n} must be registered`);
    }

    const nominated = await byName.lesson_nominate.execute({
      title: 'Test with secret sk-AbCdEf123456789012 inside',
      lesson: 'When nominating lessons, secrets must be masked before storage and materialization happens only after explicit approval.',
      context: 'plugin e2e test',
    });
    assert.ok(nominated.candidateId);
    assert.equal(nominated.redactions, 1);
    assert.deepEqual(nominated.redactionTags, ['[api-key]']);

    const pending = await byName.lesson_pending.execute({});
    assert.equal(pending.pending.length, 1);
    assert.ok(!pending.pending[0].title.includes('sk-AbCdEf'));

    const approved = await byName.lesson_approve.execute({ candidateId: nominated.candidateId });
    assert.ok(!approved.error);
    assert.ok(approved.anchor.startsWith('lessons-lesson-test-with-secret'));
    // materialized content is redacted
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(approved.filePath, 'utf8');
    assert.ok(!text.includes('sk-AbCdEf123456789012'));
    assert.ok(text.includes('[api-key]'));

    // searchable through the shared evidence index
    const evidence = new EvidenceStore(join(dir, 'evidence.sqlite'));
    try {
      const hit = evidence.search({ query: 'masked before storage explicit approval', kinds: ['lesson'] });
      assert.ok(hit.items.some((i) => i.anchor === approved.anchor), 'materialized lesson must be searchable immediately');
    } finally {
      evidence.close();
    }

    const rejectedPath = await byName.lesson_reject.execute({ candidateId: 'les-nonexist' });
    assert.equal(rejectedPath.error, 'not_found');
  } finally {
    for (const d of disposers) d();
    await rm(dir, { recursive: true, force: true });
  }
});
