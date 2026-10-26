// @local/dsh-memory-decisions — decision cue service (pure logic, testable).
//
// Clowder semantics transplanted from DecisionMemoryCueSource:
// - only `accepted` decisions with no superseder are cue candidates;
// - a candidate surfaces at most once per (owner, revision) — a changed
//   revision (edited source, rescan) legitimately re-surfaces once;
// - presented cues are recorded as terminal consumption at injection time
//   (single-user simplification: the injected line already entered the
//   agent's context; the agent can still drill for full content, and
//   memory_search remains the pull fallback);
// - budgets bound the blast radius: max cues per turn, max per UTC day.

const CUE_FAMILY = 'decision';
const ACCEPTED_ONLY = new Set(['accepted']);

/** Extract the plain user text of an upcoming turn (plugin-injected snapshots excluded). */
export function userTextOfTurn(messages, ownKind) {
  const parts = [];
  for (const message of messages ?? []) {
    const source = message?.source;
    if (source && source.kind === ownKind) continue;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * @param {object} deps
 * @param {import('@local/dsh-memory-core/store').EvidenceStore} deps.store
 * @param {string} deps.owner consumption-ledger owner (single-user default).
 */
export function createDecisionCueService(store, { owner = 'default' } = {}) {
  /** Count cue episodes recorded today (UTC) for this owner/family. */
  const presentedToday = () => {
    const dayPrefix = new Date().toISOString().slice(0, 10);
    const rows = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM cue_episodes
         WHERE owner = ? AND family = ? AND recorded_at >= ?`,
      )
      .get(owner, CUE_FAMILY, `${dayPrefix}T00:00:00`);
    return rows.n;
  };

  /**
   * Build the cue candidates for one turn.
   * @returns {{candidates: Array, cueLine: string|null, presented: Array, suppressedByBudget: number}}
   */
  function evaluateTurn({ turnText, perTurnMax = 1, dailyMax = 10 }) {
    if (!turnText || turnText.length < 4) {
      return { candidates: [], cueLine: null, suppressedByBudget: 0 };
    }
    const { items } = store.search({ query: turnText, kinds: ['decision'], limit: 20 });
    const candidates = [];
    let suppressedByBudget = 0;
    const dailyRoom = Math.max(0, dailyMax - presentedToday());
    for (const item of items) {
      if (!ACCEPTED_ONLY.has(item.status)) continue; // drafts (captured) never surface
      if (item.supersededBy) continue; // retired chain — the successor surfaces instead
      if (
        store.hasConsumedRevision({
          owner,
          family: CUE_FAMILY,
          sourceAnchor: item.anchor,
          sourceRevision: item.revision,
        })
      ) {
        continue; // this exact revision already surfaced once
      }
      const withinBudget = candidates.length < perTurnMax && candidates.length < dailyRoom;
      if (!withinBudget) {
        suppressedByBudget += 1;
        continue;
      }
      candidates.push(item);
    }
    const cueLine = renderCueLine(candidates);
    return { candidates, cueLine, suppressedByBudget };
  }

  /** Record terminal consumption for the surfaced candidates (idempotent). */
  function recordPresented(candidates) {
    for (const item of candidates) {
      store.recordCueConsumption({
        owner,
        family: CUE_FAMILY,
        sourceAnchor: item.anchor,
        sourceRevision: item.revision,
        terminal: 'presented',
      });
    }
  }

  return { evaluateTurn, recordPresented, presentedToday };
}

/** Render the injected cue line: compact, drill-ready, one line per decision. */
export function renderCueLine(candidates) {
  if (candidates.length === 0) return null;
  const lines = candidates.map(
    (item) =>
      `- decision cue: "${item.title}"${item.summary ? ` — ${item.summary}` : ''} [${item.anchor} @${item.revision}]`,
  );
  return [
    'Relevant accepted decision(s) from memory (surfaced once; verify before re-deciding):',
    ...lines,
    'If relevant, call memory_drill with the anchor and revision above for the full accepted record.',
  ].join('\n');
}

// ------------------------------------------------------- preference cues
//
// PrefEval (ICLR 2025) finding: models store preferences but fail to APPLY
// them proactively — a plain Reminder beats CoT/Self-Critic. So preferences
// rotate: each entry may re-surface once per UTC day (ledger revision key is
// day-scoped), inside a family quota, under a global cross-family ceiling
// shared with decision cues.

const PREF_FAMILY = 'preference';

/** Count preference cues presented today (UTC). */
export function preferencePresentedToday(store, owner = 'default') {
  const dayPrefix = new Date().toISOString().slice(0, 10);
  return store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM cue_episodes
       WHERE owner = ? AND family = ? AND recorded_at >= ?`,
    )
    .get(owner, PREF_FAMILY, `${dayPrefix}T00:00:00`).n;
}

/** Count ALL cue families presented today (UTC) — the shared ceiling meter. */
export function globalPresentedToday(store, owner = 'default') {
  const dayPrefix = new Date().toISOString().slice(0, 10);
  return store.db
    .prepare('SELECT COUNT(*) AS n FROM cue_episodes WHERE owner = ? AND recorded_at >= ?')
    .get(owner, `${dayPrefix}T00:00:00`).n;
}

function isPreferenceEntry(item) {
  const keywords = (item.keywords ?? []).map((k) => String(k).toLowerCase());
  return (
    item.kind === 'note' &&
    item.status === 'active' &&
    !item.supersededBy &&
    (keywords.includes('preference') || keywords.includes('preferences'))
  );
}

/**
 * Select preference cues relevant to the turn: active notes tagged
 * "preference" that (a) match the turn text, (b) have not surfaced today
 * (day-scoped ledger revision key enables daily rotation), (c) fit the
 * family quota AND the global remaining budget.
 */
export function evaluatePreferenceCues(store, { owner = 'default', turnText, perTurnMax = 1, dailyQuota = 3, globalRemaining = Number.POSITIVE_INFINITY }) {
  if (!turnText || turnText.length < 4) {
    return { candidates: [], cueLine: null, suppressedByBudget: 0 };
  }
  const today = new Date().toISOString().slice(0, 10);
  const { items } = store.search({ query: turnText, kinds: ['note'], limit: 20 });
  const candidates = [];
  let suppressedByBudget = 0;
  const quotaRoom = Math.max(0, dailyQuota - preferencePresentedToday(store, owner));
  const globalRoom = Math.max(0, Math.floor(globalRemaining));
  for (const item of items) {
    if (!isPreferenceEntry(item)) continue;
    if (store.hasConsumedRevision({ owner, family: PREF_FAMILY, sourceAnchor: item.anchor, sourceRevision: `day-${today}` })) {
      continue; // already surfaced today — rotates back tomorrow
    }
    if (candidates.length >= perTurnMax || candidates.length >= quotaRoom || candidates.length >= globalRoom) {
      suppressedByBudget += 1;
      continue;
    }
    candidates.push(item);
  }
  const cueLine = renderPreferenceCueLine(candidates);
  return { candidates, cueLine, suppressedByBudget };
}

/** Record terminal consumption with a DAY-scoped revision key (rotation). */
export function recordPreferencePresented(store, { owner = 'default' }, candidates) {
  const dayKey = `day-${new Date().toISOString().slice(0, 10)}`;
  for (const item of candidates) {
    store.recordCueConsumption({
      owner,
      family: PREF_FAMILY,
      sourceAnchor: item.anchor,
      sourceRevision: dayKey,
      terminal: 'presented',
    });
  }
}

/** Render the preference reminder (PrefEval "Reminder" baseline style). */
export function renderPreferenceCueLine(candidates) {
  if (candidates.length === 0) return null;
  const lines = candidates.map(
    (item) => `- preference cue: "${item.title}"${item.summary ? ` — ${item.summary}` : ''}`,
  );
  return [
    'Standing user preference(s) from memory — apply proactively where relevant:',
    ...lines,
  ].join('\n');
}
