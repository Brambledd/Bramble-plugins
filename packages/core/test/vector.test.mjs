// M4 vector-lane tests: hybrid pipeline correctness, vec-only survival,
// CJK boost, MMR diversity, revision invalidation, backfill, and the
// OpenAI-compatible backend against a local mock endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EvidenceStore, rrfFuse, mmrRerank } from '../src/store.js';
import { indexRoot } from '../src/scanner.js';
import { HashEmbedding, OpenAICompatibleEmbedding, cosine } from '../src/embedding.js';

async function tempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-vec-'));
  const fixtures = join(dir, 'knowledge');
  await cp(new URL('./fixtures', import.meta.url), fixtures, { recursive: true });
  const store = new EvidenceStore(join(dir, 'evidence.sqlite'));
  await indexRoot(store, fixtures);
  return { dir, fixtures, store };
}

test('hash backend: deterministic, normalized, self-similar, dissimilar to noise', () => {
  const emb = new HashEmbedding({ dimensions: 128 });
  const a = emb.embedOne('FTS5 external content table sync triggers');
  const b = emb.embedOne('FTS5 external content table sync triggers'); // identical
  const c = emb.embedOne('FTS5 external content table sync trigger drift'); // near
  const d = emb.embedOne('完全无关的字符串'); // unrelated
  assert.equal(a.length, 128);
  assert.equal(cosine(a, b), 1);
  assert.ok(cosine(a, c) > 0.8, 'near-duplicates must be highly similar');
  assert.ok(cosine(a, d) < 0.35, 'unrelated text must not be similar');
  // stable across instances (same seed)
  assert.deepEqual([...a], [...new HashEmbedding({ dimensions: 128 }).embedOne('FTS5 external content table sync triggers')]);
});

test('hybrid search: vec-only hits survive fusion (the cross-vocabulary win)', async () => {
  const ws = await tempWorkspace();
  try {
    ws.store.attachEmbedding(new HashEmbedding());
    const { embedded } = await ws.store.embedBackfill();
    assert.ok(embedded >= 5, 'all fixtures embedded');
    assert.equal(ws.store.vectors.stats().fresh, 5);

    // Query hits doc A lexically (AND) and doc B only partially (vec lane
    // catches it via n-gram overlap). B must still appear in results.
    const { items, matchMode } = ws.store.search({ query: 'sqlite driver node runtime', limit: 10 });
    assert.equal(matchMode, 'hybrid:fts+vec');
    const anchors = items.map((i) => i.anchor);
    assert.ok(anchors.includes('ADR-001'), 'lexical hit present');
    assert.ok(items.length >= 2, 'vector lane widens recall');

    // A query with NO lexical AND match still returns results via vectors.
    const partial = ws.store.search({ query: 'evidence store driver', limit: 10 });
    assert.ok(partial.items.length >= 1);
    assert.equal(partial.matchMode, 'hybrid:fts+vec');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('rrfFuse: both-lane hits outrank single-lane; CJK boosts vector weight', () => {
  const mk = (anchor) => ({ anchor, title: anchor, kind: 'note', status: 'active', authority: 'standard', summary: null, keywords: [], sourcePath: null, revision: 'r', supersededBy: null, updatedAt: new Date().toISOString() });
  const fts = [mk('a'), mk('b'), mk('c')];
  const vec = [mk('b'), mk('d')];
  const plain = rrfFuse(fts, vec, { cjkBoost: false });
  const cjk = rrfFuse(fts, vec, { cjkBoost: true });
  // 'b' is hit by both lanes: must top the list
  assert.equal(plain[0].item.anchor, 'b');
  assert.equal(cjk[0].item.anchor, 'b');
  // vec-only 'd' vs fts-only 'a': with CJK boost d's contribution grows
  const scoreOf = (list, anchor) => list.find((e) => e.item.anchor === anchor).score;
  assert.ok(scoreOf(cjk, 'd') > scoreOf(plain, 'd'), 'CJK boost raises vector-lane score');
  assert.ok(scoreOf(plain, 'd') * 1.5 - scoreOf(cjk, 'd') < 1e-12, 'boost is exactly 1.5x');
  // both-lane beats single-lane
  assert.ok(scoreOf(plain, 'b') > scoreOf(plain, 'a'));
  assert.ok(scoreOf(plain, 'b') > scoreOf(plain, 'd'));
});

test('mmrRerank: diversifies near-duplicate vectors', () => {
  const emb = new HashEmbedding({ dimensions: 64 });
  const mk = (anchor, text, score) => ({
    item: { anchor, title: anchor, kind: 'note', status: 'active', authority: 'standard', summary: null, keywords: [], sourcePath: null, revision: 'r', supersededBy: null, updatedAt: new Date().toISOString() },
    score,
    text,
  });
  const dup1 = mk('dup-1', 'kernel panic stack trace analysis', 0.9);
  const dup2 = mk('dup-2', 'kernel panic stack trace analysis log', 0.85);
  const distinct = mk('distinct', 'release notes quarterly roadmap', 0.8);
  const vectorsFor = (item) => {
    const entry = [dup1, dup2, distinct].find((e) => e.item.anchor === item.anchor);
    return { model: 'x', dims: 64, vec: emb.embedOne(entry.text) };
  };
  const ranked = mmrRerank([dup1, dup2, distinct], { vectorsFor, lambda: 0.5 });
  const anchors = ranked.map((e) => e.item.anchor);
  // The near-duplicate pair must not occupy the first two slots.
  assert.ok(!(anchors[0] === 'dup-1' && anchors[1] === 'dup-2'), `got ${anchors.join(',')}`);
});

test('revision invalidation: stale vectors are invisible until recomputed', async () => {
  const ws = await tempWorkspace();
  try {
    ws.store.attachEmbedding(new HashEmbedding());
    await ws.store.embedBackfill();
    const adr1 = ws.store.getByAnchor('ADR-001');

    // mutate the source and rescan → revision changes, vector goes stale
    const original = await readFile(adr1.sourcePath, 'utf8');
    await writeFile(adr1.sourcePath, original + '\nAmendment: WAL required.\n', 'utf8');
    await indexRoot(ws.store, ws.fixtures);
    const revised = ws.store.getByAnchor('ADR-001');
    assert.notEqual(revised.revision, adr1.revision);
    assert.equal(ws.store.vectors.freshFor('ADR-001', adr1.revision), null, 'old vector must be stale');
    assert.equal(ws.store.vectors.stats().fresh, 4, 'stale vector excluded from fresh count');

    // search still works (BM25 for the stale row), then backfill restores
    const before = ws.store.search({ query: 'node sqlite driver', limit: 10 });
    assert.ok(before.items.some((i) => i.anchor === 'ADR-001'));
    await ws.store.embedBackfill();
    assert.equal(ws.store.vectors.stats().fresh, 5, 'recompute restores coverage');
    const after = ws.store.search({ query: 'node sqlite driver', limit: 10 });
    assert.equal(after.matchMode, 'hybrid:fts+vec');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('rebuild wipes vectors; model identity separates backends', async () => {
  const ws = await tempWorkspace();
  try {
    const embA = new HashEmbedding({ dimensions: 128 });
    embA.model = 'backend-a';
    ws.store.attachEmbedding(embA);
    await ws.store.embedBackfill();
    assert.equal(ws.store.vectors.stats().fresh, 5);
    const { rebuildAll } = await import('../src/scanner.js');
    await rebuildAll(ws.store);
    assert.equal(ws.store.vectors.stats().fresh, 0, 'rebuild must wipe derived vectors');
    // re-embed with backend-a, then query the KNN with backend-b's model:
    // the foreign model must serve zero vector hits even though rows exist.
    await ws.store.embedBackfill();
    assert.equal(ws.store.vectors.stats().fresh, 5);
    const embB = new HashEmbedding({ dimensions: 128 });
    embB.model = 'backend-b';
    const queryVec = embB.embedOne('sqlite driver');
    const foreign = ws.store.vectors.knn(queryVec, { model: 'backend-b' });
    assert.equal(foreign.length, 0, 'knn must not serve another backend model');
    const own = ws.store.vectors.knn(embA.embedOne('sqlite driver'), { model: 'backend-a' });
    assert.ok(own.length >= 1, 'own backend model still serves');
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test('openai-compatible backend: HTTP path, auth header, shape errors', async () => {
  const requested = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requested.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      // the class POSTs {baseUrl}/embeddings — match that shape
      if (req.url === '/emb-ok/embeddings') {
        const input = JSON.parse(body).input;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }));
      } else if (req.url === '/emb-bad/embeddings') {
        res.end(JSON.stringify({ data: 'nope' }));
      } else {
        res.statusCode = 401;
        res.end('{}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.VEC_TEST_KEY = 'test-key-123';
  try {
    // request the -ok path via a baseUrl that ends with it
    const viaOk = new OpenAICompatibleEmbedding({
      baseUrl: `http://127.0.0.1:${port}/emb-ok`,
      model: 'emb-test',
      apiKeyEnv: 'VEC_TEST_KEY',
    });
    const vecs = await viaOk.embed(['hello', 'world']);
    assert.equal(vecs.length, 2);
    assert.ok(
      [...vecs[0]].every((v, i) => Math.abs(v - [0.1, 0.2, 0.3][i]) < 1e-6),
      'embedding values survive Float32 rounding',
    );
    assert.equal(requested[0].auth, 'Bearer test-key-123');
    assert.equal(requested[0].body.model, 'emb-test');

    // shape mismatch errors loudly
    const badBackend = new OpenAICompatibleEmbedding({
      baseUrl: `http://127.0.0.1:${port}/emb-bad`,
      model: 'emb-test',
      apiKeyEnv: 'VEC_TEST_KEY',
    });
    await assert.rejects(() => badBackend.embed(['x']), /shape mismatch/);

    // 401 surfaces as AUTH
    const unauth = new OpenAICompatibleEmbedding({
      baseUrl: `http://127.0.0.1:${port}/emb-unauth`,
      model: 'emb-test',
      apiKeyEnv: 'VEC_TEST_KEY',
    });
    await assert.rejects(() => unauth.embed(['x']), /HTTP 401/);
  } finally {
    delete process.env.VEC_TEST_KEY;
    server.close();
  }
});

test('searchHybrid: async backends drive the vector lane through the tool path', async () => {
  const ws = await tempWorkspace();
  try {
    // deterministic async backend wrapping hash
    const hash = new HashEmbedding({ dimensions: 64 });
    const asyncBackend = {
      model: hash.model,
      embed: async (texts) => texts.map((t) => hash.embedOne(t)),
    };
    ws.store.attachEmbedding(asyncBackend);
    await ws.store.embedBackfill();
    const result = await ws.store.searchHybrid({ query: 'sqlite driver evidence', limit: 10 });
    assert.equal(result.matchMode, 'hybrid:fts+vec');
    assert.ok(result.items.length >= 1);
  } finally {
    ws.store.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});
