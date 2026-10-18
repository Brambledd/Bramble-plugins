// @local/dsh-memory-lessons — DSH plugin entry (M3a: lesson distillation).
//
// Governance (Clowder discipline, single-user simplification):
// - the AI may only NOMINATE lessons (pending candidates, redacted);
// - materialization happens exclusively through lesson_approve, which the
//   agent must call only after the user explicitly approved in the
//   conversation — the prompt hint makes this contract model-visible;
// - approved lessons materialize as markdown under the lessons root (files
//   are the durable truth) and are indexed immediately so memory_search can
//   find them in the same session.
import z from '@deepseek-ai/schemastery';
import { relative, resolve } from 'node:path';
import { LessonCandidateStore } from './src/candidate-store.js';
import { redactSecrets } from './src/redactor.js';
import { EvidenceStore } from '@local/dsh-memory-core/store';
import { indexRoot } from '@local/dsh-memory-core/scanner';

export const name = 'dsh-memory-lessons';

export const inject = ['tools', 'systemPrompt'];

export const Config = z.object({
  dbPath: z.string().description('Dedicated SQLite file for the lesson candidate queue (truth side).'),
  lessonsRoot: z.string().description('Directory where approved lessons materialize as markdown (must be inside a core-indexed root).'),
  evidenceDbPath: z.string().description('Evidence index shared with dsh-memory-core, rescanned after materialization.'),
  evidenceRoot: z.string().description('The core-indexed root containing lessonsRoot (rescanned after approve).'),
  enabled: z.boolean().description('Master switch.'),
});

const PROMPT_HINT =
  'Lesson distillation: when a reusable lesson emerges (a pit, a pattern, a correction worth keeping), call lesson_nominate with a title and the distilled lesson. Nomination never writes memory by itself: tell the user, and only after they explicitly approve call lesson_approve to materialize it. lesson_pending lists open nominations.';

function resolveConfig(config) {
  const cfg = config ?? {};
  for (const key of ['dbPath', 'lessonsRoot', 'evidenceDbPath', 'evidenceRoot']) {
    if (typeof cfg[key] !== 'string' || cfg[key].length === 0) {
      throw new Error(`dsh-memory-lessons requires config \`${key}\``);
    }
  }
  return { ...cfg, enabled: cfg.enabled !== false };
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const candidates = new LessonCandidateStore(cfg.dbPath);
  const evidence = new EvidenceStore(cfg.evidenceDbPath);

  ctx.effect(() => () => {
    candidates.close();
    evidence.close();
  });

  if (!cfg.enabled) {
    ctx.logger?.info?.('dsh-memory-lessons: disabled by config');
    return;
  }

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'dsh-memory-lessons:hint',
      order: 91,
      text: PROMPT_HINT,
    }),
  );

  const register = (tool) => ctx.effect(() => ctx.tools.register(tool));

  register({
    name: 'lesson_nominate',
    description:
      'Nominate a reusable lesson for the shared memory (propose only — never writes memory). Provide a short title and the distilled lesson body. Secrets are redacted automatically. After nominating, tell the user and wait for their explicit approval before calling lesson_approve.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'lesson'],
      properties: {
        title: { type: 'string', description: 'Short imperative title of the lesson.' },
        lesson: { type: 'string', description: 'The distilled lesson body: what happened, the rule, when it applies.' },
        context: { type: 'string', description: 'Optional provenance note (session, task, file).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: value.error ? `lesson nominate failed: ${value.error}` : `lesson nominated (${value.candidateId}, pending user approval)${value.redactions > 0 ? ` — ${value.redactions} secret(s) redacted` : ''}` },
      ],
    },
    execute(args) {
      const redactedTitle = redactSecrets(String(args.title ?? ''));
      const redactedLesson = redactSecrets(String(args.lesson ?? ''));
      const redactedContext = args.context ? redactSecrets(String(args.context)) : { text: '', redactions: 0, tags: [] };
      if (redactedLesson.text.trim().length < 10) {
        return { error: 'lesson_too_short' };
      }
      const candidate = candidates.nominate({
        title: redactedTitle.text,
        lesson: redactedLesson.text,
        context: redactedContext.text || null,
        redacted:
          redactedTitle.redactions + redactedLesson.redactions + redactedContext.redactions > 0,
      });
      return {
        candidateId: candidate.id,
        status: candidate.status,
        redactions:
          redactedTitle.redactions + redactedLesson.redactions + redactedContext.redactions,
        redactionTags: [...new Set([...redactedTitle.tags, ...redactedLesson.tags, ...redactedContext.tags])],
      };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Nominate lesson', kind: 'other', rawInput: args }),
  });

  register({
    name: 'lesson_approve',
    description:
      'Materialize a nominated lesson into shared memory. ONLY call this after the user has explicitly approved the nomination in the conversation. Writes the lesson as a markdown file (durable truth) and indexes it immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['candidateId'],
      properties: {
        candidateId: { type: 'string', description: 'Candidate id from lesson_nominate.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.error
            ? `lesson approve failed: ${value.error}`
            : `lesson approved and materialized: ${value.filePath} (searchable as ${value.anchor})`,
        },
      ],
    },
    execute(args) {
      return (async () => {
        const result = await candidates.approve(String(args.candidateId ?? ''), cfg.lessonsRoot);
        if (result.error) return result;
        // Immediate re-index so the materialized lesson is searchable now.
        const scan = await indexRoot(evidence, cfg.evidenceRoot);
        const anchorSlug = anchorOf(result.filePath, cfg.evidenceRoot);
        const anchor = evidence.getByAnchor(anchorSlug);
        return {
          filePath: result.filePath,
          anchor: anchor ? anchor.anchor : anchorSlug,
          indexed: scan.scanned,
        };
      })();
    },
    presentCall: (args) => ({ card: 'generic', title: 'Approve lesson', kind: 'other', rawInput: args }),
  });

  register({
    name: 'lesson_reject',
    description: 'Reject a nominated lesson (kept for audit; never materialized). Call when the user declines.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['candidateId'],
      properties: {
        candidateId: { type: 'string', description: 'Candidate id from lesson_nominate.' },
        reason: { type: 'string', description: 'Optional rejection reason.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: value.error ? `lesson reject failed: ${value.error}` : `lesson rejected (${value.candidateId})` },
      ],
    },
    execute(args) {
      const result = candidates.reject(String(args.candidateId ?? ''));
      if (result.error) return result;
      return { candidateId: result.candidate.id, status: result.candidate.status };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Reject lesson', kind: 'other', rawInput: args }),
  });

  register({
    name: 'lesson_pending',
    description: 'List lesson nominations still awaiting the user decision.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.pending.length === 0
              ? 'no pending lesson nominations'
              : value.pending.map((c) => `- ${c.id}: ${c.title} (nominated ${c.nominated_at})`).join('\n'),
        },
      ],
    },
    execute() {
      return { pending: candidates.listPending() };
    },
    presentCall: () => ({ card: 'generic', title: 'Pending lessons', kind: 'other', rawInput: {} }),
  });
}

/** Derive the evidence anchor of a materialized lesson file (mirrors the scanner slug rule). */
function anchorOf(filePath, evidenceRoot) {
  const rel = relative(resolve(evidenceRoot), resolve(String(filePath)));
  return rel
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .toLowerCase();
}
