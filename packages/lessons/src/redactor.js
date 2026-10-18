// @local/dsh-memory-lessons — secret redaction for nominated lessons.
//
// Truth-bound materialized files must not carry credentials. Deterministic
// pattern redaction (no LLM): API-key shapes, bearer tokens, emails, IPv4
// addresses, and long hex blobs are replaced before a candidate is stored.
const PATTERNS = [
  { re: /\b(sk|rk|pk|ghp|gho|ghu|ghs|ghr|xox[baprs]|AKIA|ASIA)[A-Za-z0-9_-]{8,}\b/g, tag: '[api-key]' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, tag: '[bearer-token]' },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, tag: '[email]' },
  { re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, tag: '[ip]' },
  { re: /\b[0-9a-fA-F]{32,}\b/g, tag: '[hex-blob]' },
];

/** @returns {{text: string, redactions: number, tags: string[]}} */
export function redactSecrets(text) {
  let redactions = 0;
  const tags = [];
  let out = text;
  for (const { re, tag } of PATTERNS) {
    out = out.replace(re, () => {
      redactions += 1;
      if (!tags.includes(tag)) tags.push(tag);
      return tag;
    });
  }
  return { text: out, redactions, tags };
}
