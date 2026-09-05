/**
 * Intent Lock — turning a Founder's sentence into a recorded intent WITHOUT
 * guessing (issue #254, integration decisions D7 and D8).
 *
 * ## What "deterministic and honest" means here
 *
 * There is no model behind this file. `parseFounderCommand` is a bounded set
 * of line and sentence rules: the same text always yields the same intent,
 * every rule can be read in a minute, and a test can state exactly what a
 * given order becomes. That is a deliberate Phase 3 choice. An AI reading of
 * the order belongs to the later AI phase and to the Founder AI milestone gate;
 * building a heuristic that LOOKS like understanding would be the fake
 * later-phase behaviour the issue forbids.
 *
 * The rules capture only what the Founder wrote in a recognisable shape:
 *
 *   - a numbered line, a bullet, or `Step N:`        → a STEP of the plan
 *   - `must`, `must not`, `never`, `do not`, `only`,
 *     `always`, `no …`, or a `Constraint:` label      → a CONSTRAINT
 *   - `done when`, `acceptance:`, `success:`,
 *     `verify that`, `should …`                        → an ACCEPTANCE CRITERION
 *   - `unknown:`, `open question:`, `to decide:`       → an explicitly DECLARED UNKNOWN
 *   - everything else                                  → the OBJECTIVE
 *
 * Nothing is inferred from what the Founder did not write. A one-line order
 * with no steps is ONE task — the order itself, exactly as a direct order is
 * today — and that is not decomposition, it is the absence of any. An order
 * with three numbered steps is three tasks. An order the rules cannot read as
 * an instruction (a question, a placeholder, an unresolved "either … or", a
 * single word) is NOT turned into a plausible plan: it is recorded with its
 * unknowns, marked `needsClarification`, and yields ZERO tasks. Zero means
 * zero — the Mission Room renders it as a mission holding no task, and says
 * why.
 *
 * ## What is published, and what is not
 *
 * Every string this file extracts is the Founder's own text and stays
 * server-side, exactly as an order's instruction does (`live/orders.ts`,
 * `defaultTitle`). What may cross to the browser is the SHAPE of the intent:
 * how many constraints, how many criteria, which unknown CODES fired. The
 * code descriptions in `INTENT_UNKNOWN_DESCRIPTIONS` are generic sentences
 * written here, never quotations of the order.
 */

/**
 * A mission order may be this long.
 *
 * It is NOT, on its own, enough to keep a composed brief inside
 * `MAX_INSTRUCTION_LENGTH` — an earlier version of this comment claimed it was,
 * and that claim was wrong in a way worth recording, because the arithmetic is
 * counter-intuitive. `composeBrief` does not carry the order across; it carries
 * the objective, EVERY constraint, EVERY acceptance criterion and every declared
 * unknown into EACH step's brief, plus a label line for each. So the briefs a
 * command yields can total far more than the command, in two compounding ways:
 *
 *   - per-item overhead: each constraint or criterion costs `- ` and a newline
 *     on top of its own text, and a line of short sentences becomes many items
 *     (`no a. no b. no c.` is three constraints, not one);
 *   - per-step duplication: N steps repeat the whole constraint block N times.
 *
 * A 3,079-character order of one step and many short constraints composed to a
 * 4,248-character brief — inside every bound stated here, past the bound the
 * order path enforces. The mission was then refused with `instruction_too_long`
 * and rolled back, reporting a limit the Founder had not exceeded.
 *
 * The bound that actually holds is therefore checked where it is real, against
 * the composed briefs themselves: see `assertBriefsFit` in `command.ts`.
 */
export const MAX_COMMAND_LENGTH = 3500;
/** A plan may have at most this many steps. Beyond it the order needs splitting, not guessing. */
export const MAX_MISSION_STEPS = 12;
/** An order longer than this in LINES is a document, not a command. */
export const MAX_COMMAND_LINES = 60;

export const INTENT_UNKNOWN_CODES = [
  'empty_objective',
  'question_not_order',
  'unresolved_choice',
  'placeholder_present',
  'objective_too_short',
  'too_many_steps',
  'too_many_lines',
  'founder_declared_unknown',
] as const;

export type IntentUnknownCode = (typeof INTENT_UNKNOWN_CODES)[number];

/**
 * Generic, browser-safe sentences for each code. They describe the RULE that
 * fired, never the text it fired on.
 */
export const INTENT_UNKNOWN_DESCRIPTIONS: Record<IntentUnknownCode, string> = {
  empty_objective: 'The order states no objective and lists no step, so there is nothing to plan.',
  question_not_order: 'The order reads as a question rather than an instruction. Say what should be done.',
  unresolved_choice:
    'The order leaves a choice open (either/or, not sure, to be decided). Decide it, then amend.',
  placeholder_present: 'The order contains a placeholder (TODO, TBD, brackets). Fill it in, then amend.',
  objective_too_short: 'The order is a single word. State the objective as at least a phrase.',
  too_many_steps: `The order lists more than ${MAX_MISSION_STEPS} steps. Split it into more than one mission.`,
  too_many_lines: `The order runs past ${MAX_COMMAND_LINES} lines. A mission order is a brief, not a document.`,
  founder_declared_unknown:
    'The Founder declared an open question. It is recorded with the plan and shown to every worker; it does not stop the plan on its own.',
};

export interface IntentUnknown {
  code: IntentUnknownCode;
  /**
   * True when this unknown, on its own, stops a plan from being made. A
   * Founder-declared unknown is recorded and travels with the brief but does
   * not block: a Founder who writes "open question: which region first" and
   * still gives an objective has asked for the work to start.
   */
  blocking: boolean;
  /** The Founder's words for a declared unknown. SERVER-SIDE ONLY. */
  detail: string | null;
}

export interface ParsedIntent {
  /** The order's objective sentence(s). Empty only when the order is steps alone or unreadable. */
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  unknowns: IntentUnknown[];
  /** The task plan the rules found. Empty when nothing was written as a step AND the order is unreadable. */
  steps: string[];
  /** True when any blocking unknown fired. A clarification-needed intent yields zero tasks. */
  needsClarification: boolean;
}

const STEP_MARKER = /^(?:(\d{1,2})[.)]\s+|[-*•]\s+|step\s+\d{1,2}\s*[:.)-]\s*)(.+)$/i;
const CONSTRAINT_LABEL = /^(?:constraints?|rules?|non-?negotiables?)\s*:\s*(.+)$/i;
const CONSTRAINT_LEAD = /^(?:must(?:\s+not)?|never|do\s+not|don'?t|always|only|no|without|keep|stay|avoid|do\s+not\s+touch)\b/i;
const CRITERION_LABEL =
  /^(?:acceptance(?:\s+criteria)?|success(?:\s+criteria)?|definition\s+of\s+done|done\s+when|it\s+is\s+done\s+when|verify(?:\s+that)?)\s*:?\s*(.+)$/i;
const CRITERION_LEAD = /^(?:should|done\s+when|it\s+is\s+done\s+when|verify(?:\s+that)?)\b/i;
const UNKNOWN_LABEL = /^(?:unknown|open\s+question|to\s+decide|undecided|question)\s*:\s*(.+)$/i;

const QUESTION_LEAD = /^(?:what|why|how|when|where|who|whom|which|should|could|can|would|will|is|are|do|does|did|shall)\b/i;
const UNRESOLVED_CHOICE = /\b(?:either\b.*\bor\b|or\s+maybe|not\s+sure|unsure|undecided|whichever|tbd|to\s+be\s+decided|we'?ll\s+see)\b/i;
const PLACEHOLDER = /\b(?:TODO|TBD|XXX|FIXME)\b|\?\?\?|\[[^\]]*\]|<[^>]+>/;

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Split free text into sentences on terminal punctuation. Bounded and simple on purpose. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(normalizeSpace)
    .filter((sentence) => sentence.length > 0);
}

type Classified =
  | { kind: 'step'; text: string }
  | { kind: 'constraint'; text: string }
  | { kind: 'criterion'; text: string }
  | { kind: 'unknown'; text: string }
  | { kind: 'objective'; text: string };

/** Classify one line or sentence once its list marker (if any) has been stripped. */
function classifyBody(body: string, listed: boolean): Classified {
  const text = normalizeSpace(body);
  const unknown = UNKNOWN_LABEL.exec(text);
  if (unknown) return { kind: 'unknown', text: normalizeSpace(unknown[1]!) };
  const constraintLabel = CONSTRAINT_LABEL.exec(text);
  if (constraintLabel) return { kind: 'constraint', text: normalizeSpace(constraintLabel[1]!) };
  const criterionLabel = CRITERION_LABEL.exec(text);
  if (criterionLabel) return { kind: 'criterion', text: normalizeSpace(criterionLabel[1]!) };
  // A question is never a constraint or a criterion, whatever word it opens
  // with ("Should we…?", "Must it…?"). It is objective-shaped, and the
  // ambiguity rules below then refuse it as an order.
  if (text.endsWith('?')) return listed ? { kind: 'step', text } : { kind: 'objective', text };
  if (CONSTRAINT_LEAD.test(text)) return { kind: 'constraint', text };
  if (CRITERION_LEAD.test(text)) return { kind: 'criterion', text };
  if (listed) return { kind: 'step', text };
  return { kind: 'objective', text };
}

/**
 * Parse a Founder order into its intent. Pure; bounded; never throws on text.
 */
export function parseFounderCommand(command: string): ParsedIntent {
  const lines = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const constraints: string[] = [];
  const acceptanceCriteria: string[] = [];
  const unknowns: IntentUnknown[] = [];
  const steps: string[] = [];
  const objectiveParts: string[] = [];

  const declare = (code: IntentUnknownCode, blocking: boolean, detail: string | null = null): void => {
    if (unknowns.some((entry) => entry.code === code && entry.detail === detail)) return;
    unknowns.push({ code, blocking, detail });
  };

  if (lines.length > MAX_COMMAND_LINES) {
    declare('too_many_lines', true);
  } else {
    for (const line of lines) {
      const marker = STEP_MARKER.exec(line);
      const items: Classified[] = marker
        ? [classifyBody(marker[2]!, true)]
        : sentences(line).map((sentence) => classifyBody(sentence, false));
      for (const item of items) {
        switch (item.kind) {
          case 'step':
            steps.push(item.text);
            break;
          case 'constraint':
            constraints.push(item.text);
            break;
          case 'criterion':
            acceptanceCriteria.push(item.text);
            break;
          case 'unknown':
            declare('founder_declared_unknown', false, item.text);
            break;
          case 'objective':
            objectiveParts.push(item.text);
            break;
        }
      }
    }
  }

  const objective = normalizeSpace(objectiveParts.join(' '));

  // Ambiguity rules. Each is a statement about the order's SHAPE, decided
  // without reference to what it might mean.
  if (objective.length === 0 && steps.length === 0) declare('empty_objective', true);
  if (objective.length > 0) {
    if (objective.endsWith('?') || QUESTION_LEAD.test(objective)) declare('question_not_order', true);
    if (steps.length === 0 && objective.split(' ').length < 2) declare('objective_too_short', true);
  }
  for (const text of [objective, ...steps]) {
    if (text.length === 0) continue;
    if (UNRESOLVED_CHOICE.test(text)) declare('unresolved_choice', true);
    if (PLACEHOLDER.test(text)) declare('placeholder_present', true);
  }
  if (steps.length > MAX_MISSION_STEPS) declare('too_many_steps', true);

  const needsClarification = unknowns.some((entry) => entry.blocking);
  return {
    objective,
    constraints,
    acceptanceCriteria,
    unknowns,
    // A plan that needs clarification has no tasks. The steps the rules found
    // are still RECORDED (in the intent row) so an amendment can start from
    // them; they are simply not turned into work.
    steps: needsClarification ? [] : steps,
    needsClarification,
  };
}

/**
 * The plan a parsed intent yields, as the instruction text of each task.
 *
 * A steps-free order is one task carrying the order itself; a stepped order
 * is one task per step, each brief self-contained so a worker reading a
 * single task still sees the objective, the constraints, the criteria and the
 * declared unknowns. A clarification-needed intent yields nothing.
 */
export function planFromIntent(intent: ParsedIntent, missionTitle: string): string[] {
  if (intent.needsClarification) return [];
  if (intent.steps.length === 0) {
    return intent.objective.length === 0 ? [] : [composeBrief(intent, missionTitle, null)];
  }
  return intent.steps.map((step, index) =>
    composeBrief(intent, missionTitle, { text: step, ordinal: index + 1, count: intent.steps.length }),
  );
}

function composeBrief(
  intent: ParsedIntent,
  missionTitle: string,
  step: { text: string; ordinal: number; count: number } | null,
): string {
  const lines: string[] = [`Mission: ${missionTitle}`];
  if (intent.objective.length > 0) {
    lines.push(`Objective: ${intent.objective}`);
  } else {
    lines.push('Objective: not stated separately — the listed steps are the order.');
  }
  if (step) lines.push(`Step ${step.ordinal} of ${step.count}: ${step.text}`);
  if (intent.constraints.length > 0) {
    lines.push('Constraints (non-negotiable):');
    for (const constraint of intent.constraints) lines.push(`- ${constraint}`);
  }
  if (intent.acceptanceCriteria.length > 0) {
    lines.push('Acceptance criteria:');
    for (const criterion of intent.acceptanceCriteria) lines.push(`- ${criterion}`);
  }
  const declared = intent.unknowns.filter((entry) => entry.detail !== null);
  if (declared.length > 0) {
    lines.push('Known unknowns (declared by the Founder, not resolved — do not guess):');
    for (const entry of declared) lines.push(`- ${entry.detail}`);
  }
  return lines.join('\n');
}
