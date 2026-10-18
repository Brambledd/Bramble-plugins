// @local/dsh-memory-core — embedding backends and vector math.
//
// The vector lane is backend-agnostic:
// - HashEmbedding (default): deterministic char/word n-gram random
//   projection. Zero dependencies, zero network, stable across restarts —
//   lexical-overlap semantics only, but it makes the hybrid pipeline usable
//   out of the box and gives tests a reproducible carrier.
// - OpenAICompatibleEmbedding: POST {baseUrl}/embeddings with an API key
//   from an environment variable. Any OpenAI-shaped endpoint works (incl.
//   local serving); configured per deployment.
export class EmbeddingError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EmbeddingError';
    this.code = code;
  }
}

/** Cosine similarity of two Float32Array vectors (assumed non-zero norm). */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Deterministic PRNG (mulberry32) seeded from a string so projections are
// stable across processes — same text always maps to the same vector.
function seedFrom(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic hashed-n-gram embedding. Texts sharing character 3-grams or
 * words land near each other in the projected space. Dimensions default 256.
 */
export class HashEmbedding {
  constructor({ dimensions = 256 } = {}) {
    this.model = `hash-${dimensions}`;
    this.dimensions = dimensions;
  }

  async embed(texts) {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text) {
    const vec = new Float32Array(this.dimensions);
    const norm = String(text).toLowerCase();
    const grams = new Set();
    // words
    for (const word of norm.split(/[^\p{L}\p{N}]+/u)) {
      if (word.length > 0) grams.add(`w:${word}`);
    }
    // character 3-grams (covers CJK where word splitting is weak)
    for (let i = 0; i + 3 <= norm.length; i += 1) {
      grams.add(`c:${norm.slice(i, i + 3)}`);
    }
    // bigrams for short CJK text
    for (let i = 0; i + 2 <= norm.length; i += 1) {
      grams.add(`b:${norm.slice(i, i + 2)}`);
    }
    for (const gram of grams) {
      const rand = mulberry32(seedFrom(gram));
      // two hash slots per gram (count-sketch style) to reduce collisions
      const i1 = Math.floor(rand() * this.dimensions);
      const sign1 = rand() < 0.5 ? -1 : 1;
      vec[i1] += sign1;
      const i2 = Math.floor(rand() * this.dimensions);
      const sign2 = rand() < 0.5 ? -1 : 1;
      vec[i2] += sign2 * 0.5;
    }
    // L2 normalize
    let sq = 0;
    for (let i = 0; i < vec.length; i += 1) sq += vec[i] * vec[i];
    const normLen = Math.sqrt(sq);
    if (normLen > 0) for (let i = 0; i < vec.length; i += 1) vec[i] /= normLen;
    return vec;
  }
}

/**
 * OpenAI-compatible embeddings endpoint: POST {baseUrl}/embeddings with
 * {model, input: string[]}; expects {data: [{embedding: number[]}, ...]}.
 * The API key is read from `apiKeyEnv` at call time (never stored).
 */
export class OpenAICompatibleEmbedding {
  constructor({ baseUrl, model, apiKeyEnv, dimensions, timeoutMs = 20_000 } = {}) {
    if (!baseUrl || !model) {
      throw new EmbeddingError('openai-compatible embedding requires baseUrl and model', 'CONFIG');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.apiKeyEnv = apiKeyEnv;
    this.dimensions = dimensions ?? null;
    this.timeoutMs = timeoutMs;
  }

  async embed(texts) {
    if (texts.length === 0) return [];
    const key = this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined;
    const body = { model: this.model, input: texts };
    if (this.dimensions) body.dimensions = this.dimensions;
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new EmbeddingError(
        `embeddings endpoint HTTP ${response.status}`,
        response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP',
      );
    }
    const json = await response.json();
    if (!json?.data || !Array.isArray(json.data) || json.data.length !== texts.length) {
      throw new EmbeddingError('embeddings response shape mismatch', 'SHAPE');
    }
    return json.data.map((entry) => Float32Array.from(entry.embedding));
  }
}

/** Build a backend from a config object; null when vector lane is disabled. */
export function createEmbeddingBackend(config) {
  if (!config || config.enabled === false) return null;
  if (config.backend === 'openai') {
    return new OpenAICompatibleEmbedding(config);
  }
  return new HashEmbedding({ dimensions: config.dimensions ?? 256 });
}
