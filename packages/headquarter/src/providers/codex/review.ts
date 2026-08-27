/**
 * Codex reviewer rubric, output schema, and fail-closed result parsing
 * (Founder mission Phase 4).
 *
 * The reviewer contract:
 *   - it is given ONE exact SHA;
 *   - it returns PASS or BLOCK with severity-ranked findings;
 *   - it must not modify the code it is reviewing.
 *
 * The last point is enforced twice over: the runner passes `--sandbox
 * read-only` so the CLI physically cannot write, and run.ts re-checks the
 * worktree afterwards. The prompt below states it as well, but a prompt is
 * never the control we rely on.
 */

import {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  type CodexReviewRequest,
  type FindingCategory,
  type FindingSeverity,
  type ReviewFinding,
  type ReviewVerdict,
  type StructuredReview,
} from './types.js';

// ---------------------------------------------------------------------------
// Output schema handed to `codex exec --output-schema`
// ---------------------------------------------------------------------------

export const CODEX_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings', 'testConcerns', 'securityConcerns', 'recommendation'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'BLOCK'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'title', 'file', 'line', 'evidence'],
        properties: {
          severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
          category: { type: 'string', enum: [...FINDING_CATEGORIES] },
          title: { type: 'string' },
          file: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'] },
          evidence: { type: 'string' },
        },
      },
    },
    testConcerns: { type: 'array', items: { type: 'string' } },
    securityConcerns: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
  },
} as const;

// ---------------------------------------------------------------------------
// Reviewer instructions
// ---------------------------------------------------------------------------

export function buildReviewPrompt(request: CodexReviewRequest): string {
  const target =
    request.pullRequest != null
      ? `pull request #${request.pullRequest} at commit ${request.targetSha}`
      : `commit ${request.targetSha}`;

  const lines = [
    'You are the INDEPENDENT code reviewer for the JENIFY OS repository.',
    '',
    `Review ${target}, diffed against ${request.baseRef}.`,
    '',
    'Hard rules:',
    '- You are reviewing ONLY. Do not modify, stage, commit, push, or revert anything.',
    '  You are running in a read-only sandbox and the worktree is verified unchanged afterwards.',
    '- Review the code at the stated commit. If the working tree does not match that commit, say so',
    '  in your summary and return BLOCK rather than reviewing whatever else is present.',
    '- Do not invent business rules. JENIFY rules live in docs/ and in configuration; if a rule is',
    '  unclear, report it as an open question instead of assuming one.',
    '- Report only defects you can point at. Every finding needs concrete evidence: the input or',
    '  state that triggers it and the wrong behaviour that results. No speculative style complaints.',
    '',
    'Judgement:',
    '- verdict BLOCK if there is any CRITICAL or HIGH finding: a correctness bug, a security or',
    '  tenant-isolation hole, data loss, a broken immutable-ledger guarantee, or a missing/incorrect',
    '  test for changed behaviour.',
    '- verdict PASS if the change is correct and adequately tested, even when MEDIUM/LOW notes remain.',
    '- Rank findings most severe first. Anchor each to file and line where possible.',
    '',
    'Repository context worth knowing:',
    '- Quantities are integer milli base-units; money is integer cents. Floating point in either is a bug.',
    '- Posted transactions are never hard-deleted or silently edited: cancel/reverse/audited correction only.',
    '- Stock balances derive from an append-only ledger.',
    '- Multi-tenant: every query and route must be tenant-scoped and permission-checked.',
    '',
    'Return your review as JSON matching the provided output schema. Nothing else.',
  ];

  if (request.extraInstructions != null && request.extraInstructions.trim() !== '') {
    lines.push('', 'Additional instructions for this review:', request.extraInstructions.trim());
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fail-closed parsing
// ---------------------------------------------------------------------------

export type ReviewParseResult =
  | { ok: true; review: StructuredReview }
  | { ok: false; kind: 'empty_result' | 'unparseable_result'; message: string };

/**
 * Pull a JSON object out of the model's final message.
 *
 * Codex normally returns bare JSON when given an output schema, but a fenced
 * block or a short preamble is tolerated. What is NOT tolerated is guessing: if
 * no verdict can be read, the caller fails closed. We never default to PASS.
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  const candidates: string[] = [trimmed];

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown;
      if (v != null && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

function normaliseSeverity(v: unknown): FindingSeverity | null {
  const s = String(v ?? '').trim().toUpperCase();
  return (FINDING_SEVERITIES as readonly string[]).includes(s) ? (s as FindingSeverity) : null;
}

function normaliseCategory(v: unknown): FindingCategory {
  const s = String(v ?? '').trim().toLowerCase();
  return (FINDING_CATEGORIES as readonly string[]).includes(s) ? (s as FindingCategory) : 'other';
}

function normaliseFinding(raw: unknown): ReviewFinding | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const severity = normaliseSeverity(o['severity']);
  const title = asString(o['title']).trim();
  if (severity == null || title === '') return null;

  const lineRaw = o['line'];
  const line = typeof lineRaw === 'number' && Number.isInteger(lineRaw) && lineRaw > 0 ? lineRaw : null;
  const file = asString(o['file']).trim();

  return {
    severity,
    category: normaliseCategory(o['category']),
    title,
    file: file === '' ? null : file,
    line,
    evidence: asString(o['evidence']).trim(),
  };
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** Does this set of findings force a BLOCK regardless of the stated verdict? */
export function findingsForceBlock(findings: ReviewFinding[]): boolean {
  return findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
}

export function parseReviewOutput(text: string): ReviewParseResult {
  if (text == null || String(text).trim() === '') {
    return { ok: false, kind: 'empty_result', message: 'Codex returned no final message; nothing can be attributed to it.' };
  }

  const obj = extractJsonObject(String(text));
  if (obj === undefined) {
    return {
      ok: false,
      kind: 'unparseable_result',
      message: 'Codex returned a message that is not a JSON review object. Refusing to interpret it as a verdict.',
    };
  }

  const o = obj as Record<string, unknown>;
  const rawVerdict = String(o['verdict'] ?? '').trim().toUpperCase();
  if (rawVerdict !== 'PASS' && rawVerdict !== 'BLOCK') {
    return {
      ok: false,
      kind: 'unparseable_result',
      message: `Codex returned no usable verdict (saw '${rawVerdict || '<missing>'}'). Failing closed rather than assuming PASS.`,
    };
  }

  const findings = (Array.isArray(o['findings']) ? (o['findings'] as unknown[]) : [])
    .map(normaliseFinding)
    .filter((f): f is ReviewFinding => f != null)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // Consistency guard: a stated PASS that carries CRITICAL/HIGH findings is
  // upgraded to BLOCK. The severity evidence outranks the summary label, so a
  // reviewer cannot wave through a defect it just documented.
  let verdict = rawVerdict as ReviewVerdict;
  let summary = asString(o['summary']).trim();
  if (verdict === 'PASS' && findingsForceBlock(findings)) {
    verdict = 'BLOCK';
    summary =
      (summary === '' ? '' : `${summary}\n\n`) +
      '_Verdict upgraded to BLOCK by JENIFY: the review reported CRITICAL/HIGH findings while ' +
      'stating PASS. Severity evidence outranks the stated verdict._';
  }

  return {
    ok: true,
    review: {
      verdict,
      summary,
      findings,
      testConcerns: asStringArray(o['testConcerns']),
      securityConcerns: asStringArray(o['securityConcerns']),
      recommendation: asString(o['recommendation']).trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderReview(review: StructuredReview): string {
  const out: string[] = [`**Verdict: ${review.verdict}**`, ''];
  if (review.summary !== '') out.push(review.summary, '');

  const bySeverity = (s: FindingSeverity): ReviewFinding[] => review.findings.filter((f) => f.severity === s);

  const sections: Array<[string, FindingSeverity[]]> = [
    ['Critical findings', ['CRITICAL']],
    ['High findings', ['HIGH']],
    ['Medium / Low findings', ['MEDIUM', 'LOW']],
  ];

  for (const [heading, severities] of sections) {
    const items = severities.flatMap(bySeverity);
    out.push(`### ${heading}`, '');
    if (items.length === 0) {
      out.push('_None reported._', '');
      continue;
    }
    for (const f of items) {
      const where = f.file == null ? '' : ` — \`${f.file}${f.line == null ? '' : `:${f.line}`}\``;
      out.push(`- **[${f.severity}/${f.category}] ${f.title}**${where}`);
      if (f.evidence !== '') out.push(`  - ${f.evidence}`);
    }
    out.push('');
  }

  out.push('### Test concerns', '');
  out.push(review.testConcerns.length > 0 ? review.testConcerns.map((c) => `- ${c}`).join('\n') : '_None reported._', '');
  out.push('### Security concerns', '');
  out.push(review.securityConcerns.length > 0 ? review.securityConcerns.map((c) => `- ${c}`).join('\n') : '_None reported._', '');
  out.push('### Final recommendation', '');
  out.push(review.recommendation === '' ? '_None given._' : review.recommendation);

  return out.join('\n');
}
