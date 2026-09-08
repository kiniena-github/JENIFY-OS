/**
 * "Every facade write that stores caller text goes through one function" is
 * enforced here rather than asserted in a document (Wave 5 correction round
 * seven, Medium 2).
 *
 * ## What went wrong, and why a sentence was not enough
 *
 * Round four closed the write/read asymmetry that made a single accepted write
 * a PERMANENT `500` on a Founder read route: the strict, shape-based scan the
 * read boundary applies is now applied at the write, so a value that could
 * never be served is refused before it is stored. Twenty-nine call sites were
 * converted and the phase document said the asymmetry was closed.
 *
 * It was not. Round seven found FIVE facade writes still storing caller text
 * unscanned, and every one of them was executed all the way to the outage:
 *
 *  - `createTask`'s `title` → `500` on `/state` and `/commandCenter`;
 *  - `createTask`'s `project` → `500` on `/state`;
 *  - `failTask`'s `reason` → `500` on `/state` and `/commandCenter`;
 *  - `registerExecutionWorker`'s `displayName` → `500` on `/state`,
 *    `/workforce` and `/commandCenter`, from a CREATE-ONLY command;
 *  - `engageKillSwitch`'s `reason` → `500` on `/state` and `/commandCenter`,
 *    on the one act a Founder reaches for in a hurry to stop everything.
 *
 * None of those columns has a rewrite path through any HQ command, so each
 * outage survived every restart. A prose claim about "every write" cannot
 * notice the next one, so this file enumerates them: any public method of
 * `HeadquarterOperations` that both WRITES and declares a free-text parameter
 * must call `assertNoCredentialShape`, and the exemptions are listed with
 * their reasons rather than being silent.
 *
 * The behavioural half then proves the point end to end for the five sites the
 * correction closed, through three separate processes and every shipped
 * control route — the shape of proof the outage itself was found with.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openHqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CONTROL_ROUTES, handleControlRequest } from '../src/live/control-api.js';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(HERE, '..', 'src', 'application', 'service.ts');

/**
 * ## The predicate that made three live outages invisible (round ten, Medium 2)
 *
 * Everything below the module comment used to hang on one line:
 *
 * ```ts
 * scanned: body.includes('assertNoCredentialShape')
 * ```
 *
 * A BOOLEAN PER METHOD. One scanned parameter credited every other parameter of
 * the same method, and a curated `FREE_TEXT_PARAMETERS` list decided which
 * parameters were looked at in the first place. `credential-scan-coverage.test.ts`
 * replicated the identical predicate, so the second derived assertion could not
 * catch what the first missed. Two misses stacked, and a hostile reviewer found
 * three live outages sitting underneath 3297 green tests:
 *
 *  - `registerExecutionWorker` scanned `{ displayName, vendor }` and stored an
 *    unscanned `workerId` into `hq_specialists.id` — a permanent `500` on
 *    `/state`, `/workforce` and `/commandCenter`, from a CREATE-ONLY command
 *    with no removal path, reachable as shipped through
 *    `cli/direct-order.ts --register-worker`;
 *  - `engageKillSwitch` scanned `{ reason }` and handed an unscanned `scope`
 *    to the privileged queue;
 *  - `setIntelligenceBudget` scanned `{ note }` and `recordModelObservation`
 *    scanned `{ note, basis }`, while `scopeId`, `providerId` and `modelId`
 *    were bounded only by `isIdentifierSlug` — and `SLUG` admits `sk-…` and
 *    `ghp_…` verbatim.
 *
 * ## What is derived instead
 *
 * EVERY caller-text parameter of EVERY facade write, one row per (method,
 * parameter) pair, with no curated vocabulary anywhere in the derivation. A
 * pair is covered when the parameter is a key of an `assertNoCredentialShape` /
 * `assertBrowserSafe` literal in that method's body, or when the method hands
 * its whole input object to `callerTextRefusal`, which scans every own field.
 * The second form is why a parameter ADDED to an input type in a future phase
 * is covered the day it is added rather than the round after it is exploited.
 *
 * ## The type filter that was the ninth spelling of it (round eleven, Medium 1)
 *
 * "Every STRING parameter" was both halves of the miss. The derivation matched
 * `^string(\s*\|\s*null)?…$` and enumerated nothing else, and
 * `callerTextRefusal` kept only `typeof value === 'string'` — so a `string[]`
 * was invisible to the check AND unscanned by the guard. Two live sinks,
 * executed against the previous head:
 *
 *  - `submitResult(taskId, workerId, fence, {ok:true}, ['sk-…'])` ACCEPTED,
 *    landing in `op_evidence.payload` — `ENGINE_IMMUTABLE_TABLES[0]`, with
 *    `no_erase` and `no_rewrite`, so the row is permanent;
 *  - `postMissionMessage({ …, refs: ['sk-…'] })` ACCEPTED, landing in
 *    `hq_chat_messages.refs`.
 *
 * Neither bricked a shipped route at that head, which is what the latent half
 * of this class looks like rather than a defence of it. Both halves are closed
 * here: the matcher below reads array-of-string types too, and the guard scans
 * every own field of whatever type.
 *
 * The exemptions are named individually, with reasons, and the count of
 * deliberately-unscanned fields is DERIVED from the source below rather than
 * asserted in this sentence — the claim "there is exactly one" has been false
 * twice.
 *
 * ## The tenth spelling: the CLASSIFIER, not the parameters (round thirteen, Medium 1)
 *
 * Everything above enumerates the parameters of the methods `WRITE_MARKERS`
 * matches. The regex reads ONE method body, so a public method whose write
 * happens inside a `#private` helper is not a write as far as this file is
 * concerned — and every parameter it declares contributes ZERO rows to the
 * derivation. Neither the pair floor nor any per-method count could fire,
 * because an excluded method is not counted at all.
 *
 * Eight public methods were in that hole. Five of them genuinely write:
 *
 *  - `reconciliationAuthorityRefusal(actor)` — `#assertApprovalAuthority`
 *    appends `{ actorId: actor, action, reason }` to `op_evidence` on a
 *    refusal, MEASURED at one row per refusing branch in
 *    `safe-mode-disposition.test.ts`;
 *  - `assignTaskAsFounder` — `#resolveFounderGateActor` → `#resolveRequester`
 *    appends `{ actorId: founderId, action: 'assign task <taskId>' }` when the
 *    actor does not resolve, BEFORE `assignTask`'s own scan is reached;
 *  - `assembleCollaborationContext` — the same `#resolveRequester` append,
 *    carrying `requestedBy`;
 *  - `recordIntelligenceDecision` and `escalateIntelligenceDecision` —
 *    `#insertDecision` holds the `INSERT INTO hq_intel_decisions`, and
 *    `taskId` / `workerId` land in `task_id` / `issued_by`;
 *  - `evaluateTaskEligibility` — `this.routeTask` appends `routing_evaluated`,
 *    also measured at one row.
 *
 * None of them was a live outage at the previous head: each unscanned value is
 * bounded by canonical truth before its write, or lands only in
 * `op_evidence.payload`, which no control route serves. That is the point.
 * The defence rested on properties nobody had enumerated, which is the exact
 * substitution — a reasoned argument standing in for a derivation — this file
 * exists to end. All six are scanned at the source now, and the classifier
 * below follows the call graph so the next one cannot hide behind a helper.
 *
 * Two further spellings of the same under-reading are closed with it:
 *
 *  - a named input type was resolved only when `export interface X {` was
 *    declared in `service.ts` itself, so `registerAiMember`'s
 *    `RegisterMemberInput` — which lives in `registry/members.ts` — enumerated
 *    NOTHING. It is covered at runtime by `callerTextRefusal(input, …)`, but by
 *    luck rather than by the mechanism, because the derivation could not see a
 *    single one of its parameters. Interfaces are resolved across `src/` now;
 *  - the inline-object field matcher required `;`, `,`, a newline or `)` after
 *    the type, so a single-field object closed by `}` on the same line —
 *    `assessHqIntegrity(input: { requestedBy: string })` — also enumerated
 *    nothing.
 */

/**
 * The string parameters of a write-classified method that do NOT go through
 * the scan, each with the reason and the mechanism that makes it safe.
 *
 * `lookupPrincipal(id)` is a READ — `return this.#principalOf(id)` is its whole
 * body — and the phase document's LEFT-AVAILABLE table already says so in the
 * same words. It is reached here because the body slice a method is read from
 * runs to the NEXT method declaration, and the declarations that follow this
 * one are `#private` FIELDS with documentation of their own; the write marker
 * matches that text. It stores nothing, so there is nothing for a credential
 * shape to be stored in.
 *
 * `intelligenceBudgetDecision(scopeId)` and `intelligenceRoutingProposal(taskId)`
 * are the call graph's two OVER-APPROXIMATIONS. Both are on the READ list of
 * `safe-mode-disposition.test.ts`, which names them as reads the reachability
 * reaches only through a branch they cannot take — and MEASURES both, by table
 * delta against a real database, as writing no row at all. The exemption rests
 * on that measurement, not on this sentence: if either ever writes, the delta
 * there stops being empty and that file fails.
 *
 * Nothing else is exempt. Every other string parameter of every method the
 * classifier reaches — including the six the round-thirteen correction found —
 * reaches `assertNoCredentialShape` through one of the three covered forms.
 */
const EXEMPT_PARAMETERS: readonly string[] = [
  'lookupPrincipal.id',
  'intelligenceBudgetDecision.scopeId',
  'intelligenceRoutingProposal.taskId',
];

/**
 * The public methods this file classifies as writes ONLY because the call
 * graph is followed — each invisible to the per-body `WRITE_MARKERS` predicate
 * that classified them before.
 *
 * Asserted in both directions below, so the derivation cannot quietly stop
 * finding them and cannot quietly start finding a method by accident.
 */
const TRANSITIVE_ONLY_WRITES: readonly string[] = [
  'assembleCollaborationContext',
  'assignTaskAsFounder',
  'escalateIntelligenceDecision',
  'evaluateTaskEligibility',
  'intelligenceBudgetDecision',
  'intelligenceRoutingProposal',
  'reconciliationAuthorityRefusal',
  'recordIntelligenceDecision',
];

/**
 * Write-classified methods that declare NO caller-text parameter at all, with
 * the reason each is genuinely empty rather than under-read.
 *
 * A roster rather than a count, and asserted by EQUALITY: this is the
 * assertion that fires the day a future phase adds a text parameter to one of
 * them. The method drops out of the derived set, the equality fails, and the
 * new parameter has to be enumerated — and therefore scanned or exempted —
 * before the build is green again. Three methods used to sit here, and two of
 * them (`registerAiMember`, `assessHqIntegrity`) were under-read rather than
 * empty; both enumerate their parameters now.
 *
 * `reserveEvidence<T>(fn: () => T)` takes a callback and nothing else. There is
 * no caller text in its signature to scan.
 */
const ZERO_PARAMETER_WRITES: readonly string[] = ['reserveEvidence'];

/**
 * The pieces of caller text a facade write deliberately does not scan, as the
 * SOURCE spells them: the third argument of every `callerTextRefusal` call.
 *
 * Named at the call site rather than implied by a type filter (Wave 5
 * correction round eleven, Medium 1). It used to survive "by construction" —
 * `callerTextRefusal` read own STRING fields and a payload is a
 * `Record<string, unknown>` — and that same construction silently exempted two
 * `string[]` sinks nobody had named. An exemption that is a side effect of a
 * type check is an exemption nobody can count; this one is written down where
 * it applies, and counted here.
 *
 * What the one carve-out rests on is unchanged. No control route serves a task
 * payload — probed across every shipped route, and a payload carrying a
 * credential shape bricked none while the same shape in the title bricked two.
 * The queue applies the evidence log's own heuristic to it at `enqueue`, and
 * the strict guard for it lives at the boundary that would PUBLISH it: the
 * dispatch lane, which refuses to open an issue carrying one.
 * `claude-dispatch.test.ts` and `dispatch-durable-label.test.ts` reach that
 * boundary by writing a credential-shaped payload through `createTask` on
 * purpose, precisely to prove the dispatch guard holds INDEPENDENTLY of the
 * submission guard. Scanning the payload here would delete that
 * defence-in-depth proof, so the payload stays with the guard that owns it.
 * `createTask`'s `title` and `project` ARE scanned.
 */
function deliberatelyUnscannedFields(): string[] {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const classStart = lines.findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  const found: string[] = [];
  let method = 'callerTextRefusal';
  for (let i = classStart; i < lines.length; i += 1) {
    const declaration = /^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]);
    if (declaration && !CONTROL_WORDS.has(declaration[1])) method = declaration[1];
    // Three arguments: the input, the already-scanned list, the carve-out list.
    const call = /callerTextRefusal\([^,]+,\s*\[[^\]]*\]\s*,\s*\[([^\]]*)\]/.exec(lines[i]);
    if (!call) continue;
    for (const raw of call[1].split(',')) {
      const field = raw.trim().replace(/^['"]|['"]$/g, '');
      if (field) found.push(`${method}.${field}`);
    }
  }
  return found.sort();
}

/**
 * Every `method.field` a facade write names in `callerTextRefusal`'s
 * ALREADY-SCANNED list, derived from the source exactly as the carve-out list
 * beside it is.
 *
 * Wave 5, correction round THIRTEEN, Low 2. `callerTextRefusal` SKIPS every name
 * in this list — that is what the argument is for — and `facadeWriteParameters`
 * credited all of them anyway, because the whole-input scan `callerTextRefusal(
 * input, …)` marked every parameter of the method covered and only
 * `deliberatelyUnscanned` names were carved back out. The two lists have the
 * same effect on the scan and had opposite effects on the derivation, so a real
 * field moved into this list without an accompanying explicit scan would be
 * unscanned AND reported as covered — the exact blind spot this file exists to
 * end, in the file that ends it.
 *
 * The list is also checked for being a list of REAL fields: `recordMemory` named
 * `'so'` here, which its input does not declare, so the entry was inert. Inert
 * is the harmless outcome of a typo in this position; the harmful one is a name
 * that IS a field, and nothing distinguished the two before this derivation.
 */
function alreadyScannedFields(): string[] {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const classStart = lines.findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  const found: string[] = [];
  let method = 'callerTextRefusal';
  for (let i = classStart; i < lines.length; i += 1) {
    const declaration = /^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]);
    if (declaration && !CONTROL_WORDS.has(declaration[1])) method = declaration[1];
    // The SECOND argument: the input, then the already-scanned list. A third
    // argument may follow and is `deliberatelyUnscannedFields`' business.
    const call = /callerTextRefusal\([^,]+,\s*\[([^\]]*)\]/.exec(lines[i]);
    if (!call) continue;
    for (const raw of call[1].split(',')) {
      const field = raw.trim().replace(/^['"]|['"]$/g, '');
      if (field) found.push(`${method}.${field}`);
    }
  }
  return found.sort();
}

/**
 * A parameter type that carries CALLER TEXT into storage.
 *
 * `string[]` is here because it was not, and two live sinks were the cost
 * (Wave 5 correction round eleven, Medium 1). An array of caller strings is
 * caller text exactly as much as one caller string is; the storage it reaches
 * (`op_evidence.payload`, `hq_chat_messages.refs`) is append-only in both
 * cases.
 */
const CALLER_TEXT_TYPE =
  /^(?:readonly\s+)?string(?:\[\])?(?:\s*\|\s*null)?(?:\s*\|\s*undefined)?$/;

const CONTROL_WORDS = new Set([
  'if',
  'for',
  'switch',
  'while',
  'catch',
  'return',
  'constructor',
  'do',
  'else',
  'try',
]);

/**
 * Markers that a method body writes DIRECTLY.
 *
 * Kept exactly as it was, because it is no longer the classifier — it is the
 * base case of one. `writeClassifiedMethods()` closes it over the class's own
 * call graph, which is what a public method whose only write lives in a
 * `#private` helper needs (round thirteen, Medium 1).
 */
const WRITE_MARKERS =
  /(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)|appendEvidence\(|appendEvent\(|#upsertMeta\(|#requirePrivilegedQueue\(\)|postMessage\(|registry\.(?:register|disable|setHealth|assign|update)\(|#workerProviderRegistrar\.|#appendRunEvent\(|this\.queue\.(?:start|heartbeat|complete|fail|claim)\(/;

interface MethodSlice {
  name: string;
  /** The source from this declaration to the next one. */
  body: string;
  /** The line the declaration starts on, zero-based. */
  line: number;
}

/**
 * Every member of `HeadquarterOperations`, `#private` ones included, sliced
 * from its declaration to the next.
 *
 * The `#private` members are why this exists: they are never part of the
 * answer — the surface under test is public — but they are how a public method
 * reaches a write, so the graph has to contain them.
 */
function methodSlices(): MethodSlice[] {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const classStart = lines.findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  expect(classStart).toBeGreaterThan(-1);
  const starts: { name: string; line: number }[] = [];
  for (let i = classStart; i < lines.length; i += 1) {
    const match = /^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]);
    if (match && !CONTROL_WORDS.has(match[1])) starts.push({ name: match[1], line: i });
  }
  return starts.map((start, k) => ({
    name: start.name,
    line: start.line,
    body: lines.slice(start.line, k + 1 < starts.length ? starts[k + 1].line : lines.length).join('\n'),
  }));
}

/**
 * Every PUBLIC method that reaches a write, directly or through the class's own
 * call graph — the same fixpoint `safe-mode-disposition.test.ts` computes for
 * the safe-mode dispositions, applied here to the credential scan.
 *
 * Over-approximating on purpose. An edge is any `this.name(` or `this.#name(`
 * the body mentions, with no attempt to decide whether the branch holding it
 * can be taken, so the answer is a SUPERSET of what actually writes. That
 * direction is the safe one: a method wrongly included has to scan its
 * parameters or be named in `EXEMPT_PARAMETERS` with its reason, and a method
 * wrongly excluded is exactly the class of miss this replaces.
 */
function writeClassifiedMethods(): Set<string> {
  const slices = methodSlices();
  const bodies = new Map<string, string>();
  for (const slice of slices) {
    // Overloads and re-declared names accumulate rather than overwrite.
    bodies.set(slice.name, (bodies.get(slice.name) ?? '') + slice.body);
  }
  const writers = new Set<string>();
  for (const [name, body] of bodies) if (WRITE_MARKERS.test(body)) writers.add(name);
  const callees = new Map<string, Set<string>>();
  for (const [name, body] of bodies) {
    const found = new Set<string>();
    for (const call of body.matchAll(/this\.(#?[A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (bodies.has(call[1])) found.add(call[1]);
    }
    callees.set(name, found);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, called] of callees) {
      if (writers.has(name)) continue;
      for (const callee of called) {
        if (writers.has(callee)) {
          writers.add(name);
          grew = true;
          break;
        }
      }
    }
  }
  return new Set([...writers].filter((name) => !name.startsWith('#')));
}

/**
 * The keys of every object literal handed to `call` in `body`.
 *
 * Brace-balanced rather than `[^}]*`, because these literals are routinely
 * multi-line and a lazy match would silently credit the first field and drop
 * the rest — the same shape of under-reading that this file exists to end.
 */
function literalKeys(body: string, call: string): Set<string> {
  const keys = new Set<string>();
  const pattern = new RegExp(`${call}\\(\\s*\\{`, 'g');
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const open = body.indexOf('{', match.index);
    let depth = 0;
    let close = open;
    for (let i = open; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    for (const part of splitTopLevel(body.slice(open + 1, close))) {
      const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:,]?\s*$|^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(part);
      if (key) keys.add((key[1] ?? key[2])!);
    }
  }
  return keys;
}

/** Split on commas that are not inside brackets. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if ('({['.includes(character)) depth += 1;
    else if (')}]'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += character;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

interface ParameterFact {
  method: string;
  parameter: string;
  covered: boolean;
}

/**
 * Every public method of `HeadquarterOperations` that WRITES, with its declared
 * parameter list sliced out of the source and its body.
 *
 * Extracted from `facadeWriteParameters` unchanged (Wave 5 correction round
 * thirteen, Low 2) so the "is this a real field" derivation below and the
 * "does this field reach a scan" derivation beneath it read the SAME slice of
 * the same source. Two spellings of "the method's parameters" is how a name
 * that is a field to one and a typo to the other goes unnoticed.
 */
function facadeWriteSignatures(): { name: string; signature: string; body: string }[] {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const slices = methodSlices();
  const classified = writeClassifiedMethods();
  const found: { name: string; signature: string; body: string }[] = [];
  for (const slice of slices) {
    const from = slice.line;
    const to = from + slice.body.split('\n').length;
    const name = slice.name;
    if (name.startsWith('#')) continue;
    const body = slice.body;
    // The CALL GRAPH decides, not the regex over this one body (round
    // thirteen, Medium 1).
    if (!classified.has(name)) continue;
    // The declared parameter list, cut at the character that closes it — NOT at
    // the end of that line, which also carries the return type. Reading the
    // return type as parameters is how `messageId`, `correlationId` and
    // `artifactId` used to look like inputs.
    let depth = 0;
    let opened = false;
    let signature = '';
    outer: for (let i = from; i < to; i += 1) {
      for (const character of lines[i]) {
        if (character === '(') {
          depth += 1;
          opened = true;
        } else if (character === ')') depth -= 1;
        signature += character;
        if (opened && depth === 0) break outer;
      }
      signature += '\n';
    }
    found.push({ name, signature, body });
  }
  return found;
}

/**
 * The declared field names of one exported interface, wherever in `src/` it
 * lives.
 *
 * `namedInputStringFields` reads `service.ts` only, which is enough for the
 * inline input types the coverage derivation is about. It is NOT enough for
 * "is this name a field at all": `registerAiMember` takes a
 * `RegisterMemberInput` declared in `src/registry/members.ts`, and a check that
 * could not see it would report five real fields as typos.
 */
const INTERFACE_INDEX = new Map<string, Set<string>>();

function interfaceFields(name: string): Set<string> {
  const cached = INTERFACE_INDEX.get(name);
  if (cached) return cached;
  const fields = new Set<string>();
  const roots = [path.join(HERE, '..', 'src')];
  const files: string[] = [];
  while (roots.length > 0) {
    const dir = roots.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) roots.push(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  }
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const at = text.indexOf(`export interface ${name} {`);
    if (at < 0) continue;
    const end = text.indexOf('\n}\n', at);
    for (const field of text
      .slice(at, end < 0 ? undefined : end)
      .matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)) {
      fields.add(field[1]);
    }
  }
  INTERFACE_INDEX.set(name, fields);
  return fields;
}

/**
 * Every DECLARED field of every facade write's input, whatever its type.
 *
 * `facadeWriteParameters` enumerates only the fields that carry CALLER TEXT,
 * which is the right scope for a scan-coverage question and the wrong one for
 * "is this name a field at all" (Wave 5 correction round thirteen, Low 2).
 * `recordMemory.related` is a `RelatedRefs`, `commandMission.planSpecs` is an
 * object array — real fields, correctly outside the text enumeration, and a
 * check that used that enumeration as its dictionary would have called all of
 * them typos. Same slicing, no type filter.
 */
function facadeWriteDeclaredFields(): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>();
  for (const { name, signature } of facadeWriteSignatures()) {
    const fields = new Set<string>();
    for (const declaration of splitTopLevel(signature.slice(signature.indexOf('(') + 1))) {
      const positional = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/.exec(declaration);
      if (positional) fields.add(positional[1]);
    }
    for (const field of signature.matchAll(
      /(?:^|[{;,\n])\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/g,
    )) {
      fields.add(field[1]);
    }
    // EVERY named type the signature mentions, read whole rather than filtered
    // to its string fields — and every one, not just a trailing one:
    // `registerAiMember(input: RegisterMemberInput & { founderId: string })`
    // declares five of its fields through an intersection, and a regex anchored
    // at the end of the signature saw none of them. `RegisterMemberInput` is
    // also declared in ANOTHER module, so the interface index below spans `src/`
    // rather than `service.ts` alone.
    for (const named of signature.matchAll(/:\s*([A-Z][A-Za-z0-9_]*)/g)) {
      for (const field of interfaceFields(named[1])) fields.add(field);
    }
    declared.set(name, fields);
  }
  return declared;
}

/**
 * Every (facade write, string parameter) pair, with whether the parameter
 * reaches a scan. Derived from the source; no curated parameter vocabulary
 * takes part.
 */
function facadeWriteParameters(): ParameterFact[] {
  const facts: ParameterFact[] = [];
  for (const { name, signature, body } of facadeWriteSignatures()) {
    const inner = signature.slice(signature.indexOf('(') + 1);
    const parameters: string[] = [];
    let objectParameter: string | null = null;
    for (const declaration of splitTopLevel(inner)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:\s*([\s\S]*)$/.exec(declaration);
      if (!match) continue;
      // The default value is stripped before the type is read: `evidenceRefs:
      // string[] = []` declares `string[]`, and reading the initializer as part
      // of the type is one of the two ways that parameter stayed invisible.
      const type = match[2].trim().replace(/=[\s\S]*$/, '').trim().replace(/[)\s]+$/, '');
      if (CALLER_TEXT_TYPE.test(type)) parameters.push(match[1]);
      else if (type.startsWith('{') || /^[A-Z]/.test(type)) objectParameter = match[1];
    }
    if (objectParameter) {
      // The string fields of an inline object type, and of a named one, read
      // from the signature text itself. `}` is a terminator because a
      // single-field object closed on its own line — `input: { requestedBy:
      // string }` on `assessHqIntegrity` — matched none of the others and so
      // enumerated NOTHING (round thirteen, Medium 1).
      for (const field of signature.matchAll(
        /(?:^|[{;,\n])\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:\s*((?:readonly\s+)?string(?:\[\])?(?:\s*\|\s*null)?(?:\s*\|\s*undefined)?)\s*[;,\n)}]/g,
      )) {
        parameters.push(field[1]);
      }
      for (const field of namedInputStringFields(objectParameter, signature)) parameters.push(field);
    }
    const explicit = new Set([
      ...literalKeys(body, 'assertNoCredentialShape'),
      ...literalKeys(body, 'assertBrowserSafe'),
    ]);
    const wholeInput = new RegExp(
      `callerTextRefusal\\(\\s*${objectParameter ?? '\\u0000'}\\s*[,)]`,
    ).test(body);
    const generic = literalKeys(body, 'callerTextRefusal');
    // A field this method names in `deliberatelyUnscanned` is NOT credited by
    // the whole-input scan — the whole point of naming it is that the scan
    // skips it — so it has to earn its place in `EXEMPT_PARAMETERS` instead.
    const carvedOut = new Set(
      deliberatelyUnscannedFields()
        .filter((pair) => pair.startsWith(`${name}.`))
        .map((pair) => pair.slice(name.length + 1)),
    );
    // A field named in ALREADY-SCANNED gets the same treatment, and did not
    // (Wave 5 correction round thirteen, Low 2). `callerTextRefusal` skips both
    // lists identically, so crediting one from the whole-input scan and not the
    // other reported a skipped field as covered. It must earn coverage from an
    // EXPLICIT scan in the method body — which is what naming it here asserts
    // exists — or from being passed to `callerTextRefusal` by name.
    const alreadyScanned = new Set(
      alreadyScannedFields()
        .filter((pair) => pair.startsWith(`${name}.`))
        .map((pair) => pair.slice(name.length + 1)),
    );
    for (const parameter of new Set(parameters)) {
      facts.push({
        method: name,
        parameter,
        covered:
          !carvedOut.has(parameter) &&
          ((wholeInput && !alreadyScanned.has(parameter)) ||
            explicit.has(parameter) ||
            generic.has(parameter)),
      });
    }
  }
  return facts;
}

/**
 * Every `export interface X { … }` declared anywhere under `src/`, by name.
 *
 * Across module boundaries on purpose (round thirteen, Medium 1). The previous
 * version read `service.ts` alone, so `registerAiMember(input:
 * RegisterMemberInput & { founderId: string })` — whose interface lives in
 * `registry/members.ts` — enumerated not one of its parameters. The method IS
 * scanned at runtime, by `callerTextRefusal(input, …)`; the derivation simply
 * could not see it, which makes the coverage luck rather than mechanism, and
 * would have kept a NEW field of that interface invisible too.
 *
 * The first declaration of a name wins. A name declared twice under `src/` is
 * a collision this deliberately does not try to resolve: over-reading fields
 * costs a scan that is already there, under-reading costs a miss.
 */
function exportedInterfaces(): Map<string, string> {
  const roots = [path.join(HERE, '..', 'src')];
  const found = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(/^export interface ([A-Z][A-Za-z0-9_]*) \{$/gm)) {
          if (found.has(match[1])) continue;
          const end = source.indexOf('\n}\n', match.index!);
          found.set(match[1], source.slice(match.index!, end < 0 ? source.length : end));
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return found;
}

let interfaceCache: Map<string, string> | null = null;

/**
 * The string fields of a NAMED input interface, wherever under `src/` it is
 * declared.
 *
 * EVERY interface named in the type is read, not just the first, because an
 * input type is routinely an intersection — `RegisterMemberInput & { founderId:
 * string }` — and the inline half is already read from the signature.
 */
function namedInputStringFields(parameterName: string, signature: string): string[] {
  const named = new RegExp(`\\b${parameterName}\\s*\\??\\s*:\\s*([^,)]*)`).exec(signature);
  if (!named) return [];
  interfaceCache ??= exportedInterfaces();
  const fields: string[] = [];
  for (const reference of named[1].matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
    const declaration = interfaceCache.get(reference[1]);
    if (!declaration) continue;
    for (const field of declaration.matchAll(
      /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??:\s*(?:readonly\s+)?string\b/gm,
    )) {
      fields.push(field[1]);
    }
  }
  return fields;
}

describe('every STRING PARAMETER of every facade write reaches the one scan', () => {
  it('finds the parameters at all — the enumeration is not vacuous', () => {
    const facts = facadeWriteParameters();
    // A FLOOR on the pairs, not on the methods: the per-method count is exactly
    // what hid three of these. Deliberately not an equality and deliberately
    // not annotated with "N at this head" any more (Wave 5 correction round
    // eleven, Low 4) — a written count in a comment is the thing that has gone
    // stale in this wave over and over. What matters is that the enumeration
    // reaches far more pairs than the handful named below.
    expect(facts.length).toBeGreaterThan(280);
    const pairs = facts.map((fact) => `${fact.method}.${fact.parameter}`);
    // The five the round-ten correction closed, plus a sample of the ones
    // earlier rounds already had. Each was a live, permanent outage.
    for (const pair of [
      'registerExecutionWorker.workerId',
      'engageKillSwitch.scope',
      'setIntelligenceBudget.scopeId',
      'recordModelObservation.providerId',
      'recordModelObservation.modelId',
      'failTask.reason',
      'createTask.title',
      'createTask.project',
      'registerExecutionWorker.displayName',
      // The two round-eleven sinks. Both are `string[]`, which the matcher
      // used to skip entirely — so they were enumerated by neither half of the
      // derivation and scanned by neither guard.
      'submitResult.evidenceRefs',
      'postMissionMessage.refs',
    ]) {
      expect(pairs, `${pair} is no longer recognised as a facade write parameter`).toContain(pair);
    }
  });

  it('classifies a write behind a #private helper as a write — the call graph, not one body', () => {
    // ROUND THIRTEEN, MEDIUM 1. The predicate that decided this used to read a
    // single method body, so a public method whose only write happens inside a
    // helper was not a write here and contributed ZERO (method, parameter)
    // pairs. Nothing could fire on that: a pair floor cannot count rows a
    // method never produced, and there was no method-level assertion at all.
    const classified = writeClassifiedMethods();
    const direct = new Set(
      methodSlices()
        .filter((slice) => !slice.name.startsWith('#') && WRITE_MARKERS.test(slice.body))
        .map((slice) => slice.name),
    );
    // The classifier is a strict WIDENING of the one it replaces: everything
    // the per-body predicate found is still found.
    expect([...direct].filter((name) => !classified.has(name))).toEqual([]);
    // And the widening is exactly the roster, in both directions.
    expect([...classified].filter((name) => !direct.has(name)).sort()).toEqual(
      [...TRANSITIVE_ONLY_WRITES].sort(),
    );
    // The CONTRAST, spelled out, because it is the finding: each of these is
    // invisible to the predicate that used to be the whole classification.
    for (const name of TRANSITIVE_ONLY_WRITES) {
      expect(direct.has(name), `${name} should be invisible to the DIRECT predicate`).toBe(false);
    }
    // `recordIntelligenceDecision` is the sharpest case: its `INSERT INTO
    // hq_intel_decisions` lives in `#insertDecision`, one call away.
    const insertDecision = methodSlices().find((slice) => slice.name === '#insertDecision');
    expect(insertDecision, '#insertDecision no longer exists').toBeDefined();
    expect(WRITE_MARKERS.test(insertDecision!.body)).toBe(true);
  });

  it('every write-classified method enumerates a parameter, or is named as having none', () => {
    // The METHOD-LEVEL assertion the pair floor could never be (round
    // thirteen, Medium 1). A method that enumerates nothing is either a method
    // with no caller text or a method this file is under-reading, and the two
    // used to be indistinguishable: `registerAiMember` and `assessHqIntegrity`
    // both enumerated zero, one because its input type lived in another
    // module and one because its inline object closed with `}`.
    //
    // Asserted by EQUALITY, so adding a text parameter to a method on this
    // roster fails here until the parameter is enumerated — and therefore
    // scanned or exempted.
    const facts = facadeWriteParameters();
    const withParameters = new Set(facts.map((fact) => fact.method));
    const empty = [...writeClassifiedMethods()].filter((name) => !withParameters.has(name)).sort();
    expect(empty).toEqual([...ZERO_PARAMETER_WRITES].sort());
  });

  it('resolves an input type declared in ANOTHER module', () => {
    // `RegisterMemberInput` lives in `registry/members.ts`. Reading only
    // `service.ts` made every one of `registerAiMember`'s parameters invisible
    // to the derivation, which left it covered by luck rather than mechanism.
    const service = fs.readFileSync(SERVICE, 'utf8');
    expect(
      service.includes('export interface RegisterMemberInput {'),
      'RegisterMemberInput moved into service.ts; this test no longer proves cross-module resolution',
    ).toBe(false);
    const pairs = new Set(
      facadeWriteParameters().map((fact) => `${fact.method}.${fact.parameter}`),
    );
    for (const parameter of ['displayName', 'providerId', 'modelId', 'modelVersion']) {
      expect(pairs, `registerAiMember.${parameter} is not enumerated`).toContain(
        `registerAiMember.${parameter}`,
      );
    }
    // And the single-field inline object, the other spelling of enumerating
    // nothing.
    expect(pairs).toContain('assessHqIntegrity.requestedBy');
    // Every one of them reaches the scan, which is what the derivation could
    // not previously say.
    for (const fact of facadeWriteParameters()) {
      if (fact.method === 'registerAiMember' || fact.method === 'assessHqIntegrity') {
        expect(fact.covered, `${fact.method}.${fact.parameter} is not covered`).toBe(true);
      }
    }
  });

  it('the parameters of every transitively-classified write reach the scan', () => {
    // The six that genuinely write are covered at the SOURCE now, not excused
    // here. The two the call graph only over-approximates are in
    // `EXEMPT_PARAMETERS` with their measurement named.
    const facts = facadeWriteParameters();
    const byMethod = new Map<string, ParameterFact[]>();
    for (const fact of facts) {
      byMethod.set(fact.method, [...(byMethod.get(fact.method) ?? []), fact]);
    }
    for (const method of [
      'reconciliationAuthorityRefusal',
      'assignTaskAsFounder',
      'assembleCollaborationContext',
      'recordIntelligenceDecision',
      'escalateIntelligenceDecision',
      'evaluateTaskEligibility',
    ]) {
      const parameters = byMethod.get(method) ?? [];
      expect(parameters.length, `${method} enumerates no parameter`).toBeGreaterThan(0);
      for (const fact of parameters) {
        expect(fact.covered, `${method}.${fact.parameter} does not reach a scan`).toBe(true);
      }
    }
  });

  it('names every deliberately unscanned field, and there is exactly one', () => {
    // DERIVED, not written down (Wave 5 correction round eleven, Medium 1).
    // The sentence "there is exactly one carve-out" was false at the previous
    // head — `createTask.payload`, `submitResult.evidenceRefs` and
    // `postMissionMessage.refs` were all unscanned — because two of the three
    // were exempted by a type filter nobody had to name. An exemption is now a
    // literal at the call site, so it can be counted.
    expect(deliberatelyUnscannedFields()).toEqual(['createTask.payload']);
  });

  it('names only REAL fields in the already-scanned list, so an inert entry cannot hide', () => {
    // Wave 5, correction round thirteen, Low 2. `recordMemory` named `'so'`
    // here and its input declares no such field, so the entry skipped nothing.
    // A typo in this position is harmless only by luck: the same slip on a name
    // that IS a field silently removes it from the scan. Derived from the
    // source on both sides — the list from the call site, the fields from the
    // signature — so neither can be asserted about the other in prose.
    const declared = facadeWriteDeclaredFields();
    const inert: string[] = [];
    for (const pair of alreadyScannedFields()) {
      const at = pair.indexOf('.');
      const method = pair.slice(0, at);
      const field = pair.slice(at + 1);
      // Only methods this file's own enumeration reaches can be judged: a name
      // on a method the write-marker filter never selected says nothing.
      const fields = declared.get(method);
      if (!fields) continue;
      if (!fields.has(field)) inert.push(pair);
    }
    expect(inert, 'these already-scanned names are not fields of their method’s input').toEqual([]);
    // Not vacuous: the list has to be reaching real call sites at all.
    expect(alreadyScannedFields().length).toBeGreaterThan(20);
    expect(alreadyScannedFields()).toContain('recordMemory.sourceRefs');
    expect(alreadyScannedFields()).not.toContain('recordMemory.so');
  });

  it('an already-scanned field is NOT credited by the whole-input scan either', () => {
    // The same laundering the carve-out test below forbids, in the other list
    // (Wave 5 correction round thirteen, Low 2). `callerTextRefusal` skips both
    // lists identically, so a name here must earn coverage from an EXPLICIT
    // scan in the method body, never from `callerTextRefusal(input, …)` having
    // been called at all.
    //
    // Executed against the derivation rather than argued: every already-scanned
    // pair the enumeration reaches is checked to be covered by an explicit scan,
    // which is what naming it asserts. If one were covered ONLY by the whole
    // input, it would now be reported uncovered and this file's main assertion
    // would fail — which is the point.
    const facts = new Map(
      facadeWriteParameters().map((fact) => [`${fact.method}.${fact.parameter}`, fact.covered]),
    );
    const uncovered: string[] = [];
    for (const pair of alreadyScannedFields()) {
      if (!facts.has(pair)) continue;
      if (!facts.get(pair)) uncovered.push(pair);
    }
    expect(
      uncovered,
      'these fields are skipped by the generic scan and not scanned explicitly',
    ).toEqual([]);
  });

  it('a carved-out field is NOT credited by the whole-input scan', () => {
    // The derivation must not launder the exemption it exists to expose: with
    // `payload` named as deliberately unscanned, the pair has to be carried by
    // `EXEMPT_PARAMETERS` if it is enumerated at all, never silently covered.
    const facts = facadeWriteParameters();
    for (const fact of facts) {
      if (`${fact.method}.${fact.parameter}` === 'createTask.payload') {
        expect(fact.covered).toBe(false);
      }
    }
  });

  it('no string parameter of a facade write reaches storage unscanned', () => {
    const uncovered = facadeWriteParameters()
      .filter((fact) => !fact.covered)
      .map((fact) => `${fact.method}.${fact.parameter}`)
      .filter((pair) => !EXEMPT_PARAMETERS.includes(pair));
    expect(uncovered).toEqual([]);
  });

  it('the exemption list names only parameters that still exist', () => {
    const pairs = new Set(
      facadeWriteParameters().map((fact) => `${fact.method}.${fact.parameter}`),
    );
    const stale = EXEMPT_PARAMETERS.filter((pair) => !pairs.has(pair));
    expect(stale, 'the exemption list names a parameter that no longer exists').toEqual([]);
  });

  it('the docstring claim on assertNoCredentialShape is derived rather than asserted', () => {
    // NEW MEDIUM B. The sentence "this is now true of the facade, with ONE
    // carve-out" was falsified three times by execution. It may only stand
    // while the derivation above stands, so the sentence names this file.
    const source = fs.readFileSync(SERVICE, 'utf8');
    const at = source.indexOf('function callerTextRefusal(');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(0, at)).toContain('facade-write-scan.test.ts');
  });

  it('createTask scans, even though its parameters arrive inside a named input type', () => {
    // Its signature is `createTask(input: CreateTaskInput)`. Asserted directly
    // as well as through the derivation, because these are two of the columns
    // the outage was found on.
    const source = fs.readFileSync(SERVICE, 'utf8');
    const from = source.indexOf('  createTask(input: CreateTaskInput)');
    expect(from).toBeGreaterThan(-1);
    const body = source.slice(from, source.indexOf('\n  }\n', from));
    expect(body).toContain('assertNoCredentialShape');
    expect(body).toContain('title');
    expect(body).toContain('project');
  });
});

/* ------------------------------------------------------------------ */
/* The behavioural half: a real file, three processes, every route.    */
/* ------------------------------------------------------------------ */

const CREDENTIAL = 'sk-ABCDEFGHIJKLMNOP0123456789';
const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-08-28T16:00:00.000Z');
const ACCOUNT = {
  realmId: 'tenant',
  accountId: 'user',
  displayName: 'Founder',
  authenticatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
};
const READ_STATUS = 'hq.read_status';

interface WriteProbe {
  /** Which routes answered 500 in a FRESH process after the attempted write. */
  brickedRoutes: string[];
  /** Whether the facade accepted the write. */
  accepted: boolean;
  /** The refusal code when it did not. */
  code: string | null;
  /**
   * The refusal MESSAGE when it did not.
   *
   * Carried because a code alone is not proof that the CREDENTIAL guard is
   * what answered: `invalid_input` is also what an unconfigured intelligence
   * store and half a dozen shape checks answer, so a probe that asserted the
   * code alone passed against the very head the outage was found on.
   */
  message: string | null;
}

/**
 * The seeded, unwritten-to store every probe below starts from, built once.
 *
 * Every one of the fifteen probes in this file needs the SAME starting state —
 * the schema, `hq.read_status`, the two specialists and the Founder — and then
 * needs its own file to attempt its own write against. Only the second half of
 * that has to be per-probe. The first half was being rebuilt fifteen times.
 *
 * The cost is fsync, not CPU: `openHqDatabase` sets `synchronous = FULL`, so
 * every commit in the seeding is a flush to storage. Measured at this head with
 * `strace -f -c -e trace=fsync`, one probe was 263 fsyncs, and
 * `recordModelObservation` — the only test here that probes TWICE, because it
 * has two credential-shaped fields to refuse — was 526, the highest in the
 * file. On this machine that is 295 ms and invisible. A timeout is wall time
 * though, and on slower storage those 526 flushes are the whole of it: at 9 ms
 * per fsync this test takes 5.4 s against vitest's 5000 ms default, which is
 * what failed in CI while its 263-fsync siblings passed.
 *
 * So the seeding is done ONCE and the file is COPIED per probe. A cleanly
 * closed HQ database is a single file with no WAL or shared-memory residue
 * (asserted below), so each probe gets a byte-for-byte copy of the same seeded
 * store. Nothing about what a probe DOES changes: it still attempts its write
 * against its own fresh file, and still replays every control route from two
 * separate opens afterwards.
 */
let seededTemplate: { dir: string; dbPath: string } | null = null;

function seededTemplatePath(): string {
  if (seededTemplate) return seededTemplate.dbPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-write-scan-template-'));
  const dbPath = path.join(dir, 'hq.sqlite');
  const db = openHqDatabase(dbPath);
  const store = new HeadquarterStore(db);
  new CapabilityRegistry(db).register({
    id: READ_STATUS,
    description: 'read',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  store.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [READ_STATUS],
    active: true,
  });
  store.upsertSpecialist({
    id: 'codex',
    displayName: 'Codex',
    vendor: 'openai',
    role: 'reviewer_gatekeeper',
    allowedCapabilities: [READ_STATUS],
    active: true,
  });
  new HumanPrincipalRegistry(db).register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [READ_STATUS],
    approvalAuthority: true,
    active: true,
  });

  // The clean boot, done HERE rather than fifteen times over.
  //
  // This is where the cost actually was, and it is worth naming precisely
  // because it is not where it looks. Constructing `HeadquarterOperations`
  // over a store that has never booted performs that store's one-time
  // initialisation, and that initialisation is 225 of a probe's 253 fsyncs —
  // measured by stage below. Every construction AFTER the first, on the same
  // file, costs about 7. So a probe was paying a full first boot, and the two
  // replay passes that follow it were nearly free by comparison.
  //
  // Booting the template once therefore moves 225 fsyncs per probe into 225
  // fsyncs per FILE. It does not make the probe start from a different kind of
  // store: an HQ that a Founder can reach has necessarily booted already, and
  // the write attempt, both replay passes and every assertion are unchanged.
  new HeadquarterOperations(db, {
    store,
    policyCtx: { preApprovedCapabilities: new Set<string>([READ_STATUS]) },
  });
  db.close();

  // The property that makes copying equivalent to re-seeding, asserted rather
  // than assumed: after a clean close the store is ONE file. A `-wal` or `-shm`
  // left beside it would mean the copy handed to a probe was missing the most
  // recent commits, and this fails instead of seeding a probe short.
  expect(fs.readdirSync(dir)).toEqual([path.basename(dbPath)]);

  seededTemplate = { dir, dbPath };
  return dbPath;
}

// Built in a hook rather than lazily inside whichever probe happens to run
// first, so the one shared seeding-and-boot is charged to the shared setup and
// each test's own budget covers only its own work. Vitest gives a hook 10 s and
// a test 5 s, which is the right way round for a fixture every probe reuses.
beforeAll(() => {
  seededTemplatePath();
});

afterAll(() => {
  if (seededTemplate) fs.rmSync(seededTemplate.dir, { recursive: true, force: true });
  seededTemplate = null;
});

/**
 * Attempt one write carrying a credential shape, then read every shipped
 * control route from two SEPARATE processes over the same file. Two processes
 * because the original defect was permanent, not transient: the first outage
 * proved the row was served, the second proved a restart did not clear it.
 */
function probeWrite(
  act: (ops: HeadquarterOperations) => { ok: boolean; code: string | null; message: string | null },
): WriteProbe {
  const template = seededTemplatePath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-write-scan-'));
  const dbPath = path.join(dir, 'hq.sqlite');
  fs.copyFileSync(template, dbPath);
  const open = () => {
    const db = openHqDatabase(dbPath);
    const store = new HeadquarterStore(db);
    const ops = new HeadquarterOperations(db, {
      store,
      policyCtx: { preApprovedCapabilities: new Set<string>([READ_STATUS]) },
    });
    return { db, ops, store };
  };
  try {
    let accepted = false;
    let code: string | null = null;
    let message: string | null = null;
    {
      const { db, ops } = open();
      const outcome = act(ops);
      accepted = outcome.ok;
      code = outcome.code;
      message = outcome.message;
      db.close();
    }
    const bricked = new Set<string>();
    for (let pass = 0; pass < 2; pass += 1) {
      const { db, ops } = open();
      const deps = {
        ops,
        founderMap: [{ realmId: 'tenant', accountId: 'user', principalId: 'founder' }],
        allowedOrigins: [ORIGIN],
        secretsEnv: {},
        sessions: { resolve: () => ACCOUNT },
        credentials: { verify: () => 'ok' },
        audit: { record: () => {} },
        now: () => NOW,
      } as unknown as Parameters<typeof handleControlRequest>[1];
      for (const [name, route] of Object.entries(CONTROL_ROUTES)) {
        if (typeof route !== 'string') continue;
        const response = handleControlRequest(
          {
            method: 'GET',
            path: route,
            headers: { referer: `${ORIGIN}/hq/console.html`, host: 'hq.example' },
          },
          deps,
        );
        if (response.status === 500) bricked.add(name);
      }
      db.close();
    }
    return { brickedRoutes: [...bricked].sort(), accepted, code, message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function refusal(result: { ok: boolean; error?: { code: string; message?: string } }): {
  ok: boolean;
  code: string | null;
  message: string | null;
} {
  return {
    ok: result.ok,
    code: result.ok ? null : (result.error?.code ?? null),
    message: result.ok ? null : (result.error?.message ?? null),
  };
}

/**
 * The explicit deadline every file-backed probe below carries.
 *
 * Vitest's 5 s default is not a statement about these tests. Each one creates a
 * real SQLite file, opens it in three separate stores and replays every shipped
 * control route twice over it — that is the shape of proof the outage was found
 * with, and none of it is being reduced. On a shared `ubuntu-latest` runner one
 * of them (`recordModelObservation`, which runs the probe twice) failed with
 * `Test timed out in 5000ms` while passing on every other head and on every
 * developer machine; its siblings run the same helper and sit within 1.5x of
 * it, so they are at the same risk and are treated the same way.
 *
 * Measured on this machine with the whole package running in parallel:
 * 160-361 ms per test, the slowest being `recordModelObservation` at 361 ms
 * (268 ms with the file run alone). 30 s is ~83x that slowest observed run.
 *
 * Per test rather than a package-wide `testTimeout`: raising the global default
 * would relax the deadline for every test in this package, including the many
 * where a hang is the real signal. Only the harness deadline changes here;
 * every assertion is untouched.
 *
 * The sentence above used to state a whole-suite test count (Wave 5 correction
 * round thirteen, Low 3). It was already stale by the time it shipped — the
 * figure is deliberately not restated here, because a numeral in this comment
 * is the very thing the rule below refuses, and quoting the retired one would
 * reopen the hole while describing it. This same wave had just retired the
 * hand counts from
 * `PHASE_13_ADVANCED_RELIABILITY.md` on the grounds that a present-tense count
 * in a comment is a claim about the code that nothing checks. The number is
 * dropped rather than re-counted: nothing here depends on how many tests the
 * package has, only on the deadline being per-test.
 */
const FILE_BACKED_PROBE_TIMEOUT_MS = 30_000;

describe('the five writes that permanently bricked a Founder read route now refuse instead', () => {
  it('createTask refuses a credential-shaped title, and no route is bricked', () => {
    const probe = probeWrite((ops) =>
      refusal(
        ops.createTask({
          capabilityId: READ_STATUS,
          payload: { branch: 'main' },
          idempotencyKey: 'k1',
          requestedBy: 'claude',
          title: `prod deploy ${CREDENTIAL}`,
        }),
      ),
    );
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('createTask refuses a credential-shaped project, and no route is bricked', () => {
    const probe = probeWrite((ops) =>
      refusal(
        ops.createTask({
          capabilityId: READ_STATUS,
          payload: { branch: 'main' },
          idempotencyKey: 'k1',
          requestedBy: 'claude',
          project: `mesob ${CREDENTIAL}`,
        }),
      ),
    );
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('failTask refuses a credential-shaped reason, and no route is bricked', () => {
    const probe = probeWrite((ops) => {
      const created = ops.createTask({
        capabilityId: READ_STATUS,
        payload: { branch: 'main' },
        idempotencyKey: 'k1',
        requestedBy: 'claude',
      });
      if (!created.ok) return { ok: true, code: null, message: null };
      const claimed = ops.claimNext('claude', READ_STATUS, undefined, created.data.task.id);
      if (!claimed.ok) return { ok: true, code: null, message: null };
      ops.startTask(created.data.task.id, 'claude', claimed.data.fence);
      return refusal(
        ops.failTask(
          created.data.task.id,
          'claude',
          claimed.data.fence,
          `the deploy blew up using ${CREDENTIAL}`,
        ),
      );
    });
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('registerExecutionWorker refuses a credential-shaped displayName, and no route is bricked', () => {
    const probe = probeWrite((ops) =>
      refusal(
        ops.registerExecutionWorker({
          workerId: 'gemini',
          displayName: `Gemini ${CREDENTIAL}`,
          vendor: 'google',
          role: 'build_lead',
          allowedCapabilities: [READ_STATUS],
          founderId: 'founder',
        }),
      ),
    );
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('engageKillSwitch refuses a credential-shaped reason, and no route is bricked', () => {
    const probe = probeWrite((ops) =>
      refusal(ops.engageKillSwitch('global', 'founder', `stop everything: ${CREDENTIAL}`)),
    );
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('the fail-safe act still works with an ordinary reason — the guard refuses credentials, not stopping', () => {
    const probe = probeWrite((ops) =>
      refusal(ops.engageKillSwitch('global', 'founder', 'Suspected credential leak in the pipeline.')),
    );
    expect(probe.accepted).toBe(true);
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('the payload carve-out is exactly that, and no wider: a credential-shaped PAYLOAD is stored and bricks nothing', () => {
    // The executed half of the carve-out recorded at the top of this file. If
    // a future read starts publishing task payloads, this test starts failing
    // and the carve-out has to be revisited rather than quietly inherited.
    const probe = probeWrite((ops) =>
      refusal(
        ops.createTask({
          capabilityId: READ_STATUS,
          payload: { instruction: `deploy using ${CREDENTIAL}` },
          idempotencyKey: 'k1',
          requestedBy: 'claude',
        }),
      ),
    );
    expect(probe.accepted).toBe(true);
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  /* ---------------------------------------------------------------- */
  /* Round ten: the five parameters the per-METHOD credit hid.          */
  /* ---------------------------------------------------------------- */

  it('registerExecutionWorker refuses a credential-shaped workerId, and no route is bricked', () => {
    // HIGH 1. `workerId` lands in `hq_specialists.id`, which
    // `liveSnapshotFromOperations` publishes; the row survives
    // `deactivateExecutionWorker` (it only sets `active = 0`) and the facade
    // exposes no removal, so the outage was permanent and unrecoverable.
    const probe = probeWrite((ops) =>
      refusal(
        ops.registerExecutionWorker({
          workerId: CREDENTIAL,
          displayName: 'Gemini',
          vendor: 'google',
          role: 'build_lead',
          allowedCapabilities: [READ_STATUS],
          founderId: 'founder',
        }),
      ),
    );
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('engageKillSwitch refuses a credential-shaped scope, and no route is bricked', () => {
    // HIGH 2. `scope` reached `#requirePrivilegedQueue().engageKillSwitch`
    // unscanned while only `reason` was checked.
    const probe = probeWrite((ops) =>
      refusal(ops.engageKillSwitch(CREDENTIAL, 'founder', 'Suspected leak.')),
    );
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    expect(probe.message).toContain('credential shape');
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('setIntelligenceBudget refuses a credential-shaped scopeId', () => {
    // HIGH 5. `scopeId` got `canonicalBudgetScopeId` and a length check; the
    // scan covered `note` alone. `hq_intel_budgets` is INSERT-only.
    const probe = probeWrite((ops) =>
      refusal(
        ops.setIntelligenceBudget({
          scopeKind: 'provider',
          scopeId: CREDENTIAL,
          window: 'month',
          ceilingMinorUnits: 1000,
          currency: 'USD',
          permittedTiers: ['deterministic_local'],
          setBy: 'founder',
        }),
      ),
    );
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    // The MESSAGE, not only the code: `invalid_input` is also what an
    // unconfigured intelligence store answers on this fixture, so a code-only
    // assertion passes against the head the outage was found on.
    expect(probe.message).toContain('credential shape');
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('recordModelObservation refuses a credential-shaped providerId and modelId', () => {
    // HIGH 5, the other half. `isIdentifierSlug`'s
    // `/^[a-z0-9][a-z0-9._:-]*$/` admits `sk-…` and `ghp_…` verbatim, so the
    // slug rule was never a guard against this shape.
    for (const attempt of [
      { providerId: CREDENTIAL.toLowerCase(), modelId: 'sonnet' },
      { providerId: 'anthropic', modelId: CREDENTIAL.toLowerCase() },
    ]) {
      const probe = probeWrite((ops) =>
        refusal(
          ops.recordModelObservation({
            ...attempt,
            locality: 'cloud',
            availability: 'healthy',
            unitCostProvenance: 'unknown',
            unitCostUnitKind: 'tokens_total',
            source: 'founder_declared',
            observedBy: 'founder',
          }),
        ),
      );
      expect(probe.accepted, JSON.stringify(attempt)).toBe(false);
      expect(probe.code, JSON.stringify(attempt)).toBe('invalid_input');
      expect(probe.message, JSON.stringify(attempt)).toContain('credential shape');
      expect(probe.brickedRoutes, JSON.stringify(attempt)).toEqual([]);
    }
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('the sibling that already had it right is unchanged: recordIntelligenceCost still refuses', () => {
    // NEW MEDIUM A. The correct guard was eleven lines away the whole time —
    // `recordIntelligenceCost` runs `assertBrowserSafe({ providerId, modelId })`
    // and refuses. The three siblings now apply the same guard; this pins that
    // the one that was right did not regress while they were brought into line.
    const probe = probeWrite((ops) =>
      refusal(
        ops.recordIntelligenceCost({
          providerId: CREDENTIAL.toLowerCase(),
          modelId: 'sonnet',
          taskId: 'no-such-task',
          workerId: 'claude',
          fence: 1,
          provenance: 'unknown',
          unitKind: 'tokens_total',
        }),
      ),
    );
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('an ordinary worker id, kill-switch scope, budget scope and model id all still land', () => {
    // The guard refuses credential SHAPES, not identifiers. Without this the
    // fix above could be a refusal of everything.
    const probe = probeWrite((ops) => {
      const worker = ops.registerExecutionWorker({
        workerId: 'gemini',
        displayName: 'Gemini',
        vendor: 'google',
        role: 'build_lead',
        allowedCapabilities: [READ_STATUS],
        founderId: 'founder',
      });
      if (!worker.ok) return refusal(worker);
      const stopped = ops.engageKillSwitch(READ_STATUS, 'founder', 'Pausing this capability.');
      if (!stopped.ok) return refusal(stopped);
      return refusal(ops.releaseKillSwitch(READ_STATUS, 'founder'));
    });
    expect(probe.accepted).toBe(true);
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('the ordinary shape of each write still lands', () => {
    const probe = probeWrite((ops) =>
      refusal(
        ops.createTask({
          capabilityId: READ_STATUS,
          payload: { branch: 'main' },
          idempotencyKey: 'k1',
          requestedBy: 'claude',
          title: 'Production deploy for the Mesob line',
          project: 'mesob',
        }),
      ),
    );
    expect(probe.accepted).toBe(true);
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);
  it('an array of caller strings is refused at both round-eleven sinks', () => {
    // Executed against the previous head, both were ACCEPTED and both landed
    // in append-only storage: `op_evidence.payload` (`no_erase`/`no_rewrite`)
    // and `hq_chat_messages.refs`. Neither bricked a shipped route, which is
    // why the derivation above had to grow rather than the two call sites.
    const submitted = probeWrite((ops) => {
      const created = ops.createTask({
        capabilityId: READ_STATUS,
        payload: {},
        idempotencyKey: 'refs-probe',
        requestedBy: 'claude',
      });
      if (!created.ok) return refusal(created);
      const claimed = ops.claimNext('claude', READ_STATUS, undefined, created.data.task.id);
      if (!claimed.ok) return refusal(claimed);
      const running = ops.startTask(created.data.task.id, 'claude', claimed.data.fence);
      if (!running.ok) return refusal(running);
      return refusal(
        ops.submitResult(created.data.task.id, 'claude', running.data.fence, { ok: true }, [CREDENTIAL]),
      );
    });
    expect(submitted.accepted).toBe(false);
    expect(submitted.code).toBe('invalid_input');
    expect(submitted.message).toContain('credential shape');
    expect(submitted.brickedRoutes).toEqual([]);

    const posted = probeWrite((ops) =>
      refusal(
        ops.postMissionMessage({
          threadId: 'room-build',
          author: 'founder',
          body: 'hello',
          refs: [CREDENTIAL],
        }),
      ),
    );
    expect(posted.accepted).toBe(false);
    expect(posted.code).toBe('invalid_input');
    expect(posted.message).toContain('credential shape');
    expect(posted.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('the ordinary shapes of both still land, refs and all', () => {
    // The other half of every round of this correction: a guard that refuses
    // everything is not a fix.
    const submitted = probeWrite((ops) => {
      const created = ops.createTask({
        capabilityId: READ_STATUS,
        payload: {},
        idempotencyKey: 'refs-ok',
        requestedBy: 'claude',
      });
      if (!created.ok) return refusal(created);
      const claimed = ops.claimNext('claude', READ_STATUS, undefined, created.data.task.id);
      if (!claimed.ok) return refusal(claimed);
      const running = ops.startTask(created.data.task.id, 'claude', claimed.data.fence);
      if (!running.ok) return refusal(running);
      return refusal(
        ops.submitResult(created.data.task.id, 'claude', running.data.fence, { ok: true }, [
          'https://github.com/kiniena-github/jenify-os/pull/271',
          'docs/HEADQUARTER/PHASE_13_ADVANCED_RELIABILITY.md',
        ]),
      );
    });
    expect(submitted.accepted).toBe(true);
    expect(submitted.brickedRoutes).toEqual([]);

    const posted = probeWrite((ops) =>
      refusal(
        ops.postMissionMessage({
          threadId: 'room-build',
          author: 'founder',
          body: 'Notes on the salt line',
          refs: ['mission-1', 'የጨው ፋብሪካ'],
        }),
      ),
    );
    expect(posted.accepted).toBe(true);
    expect(posted.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);

  it('the whole-input scan does not refuse ordinary human text — 16 shapes swept', () => {
    // The availability half, re-verified after the type filter was removed.
    // Every one of these is text a Founder or a worker may legitimately write,
    // and each is swept through a STRING field and an ARRAY field of the same
    // write; a scan that reaches more fields must not start refusing more
    // content.
    const shapes: string[] = [
      'Ship the Mesob salt line report by Friday.',
      '\u12e8\u1329\u12cd \u134b\u1265\u122a\u12ab \u122a\u1356\u122d\u1275',
      '\u062a\u0642\u0631\u064a\u0631 \u0645\u0635\u0646\u0639 \u0627\u0644\u0645\u0644\u062d',
      '\u0928\u092e\u0915 \u0915\u093e\u0930\u0916\u093e\u0928\u093e \u0930\u093f\u092a\u094b\u0930\u094d\u091f',
      'Tuz fabrikas\u0131 raporu',
      'Rapport de l\u2019usine de sel',
      'B\u00e1o c\u00e1o nh\u00e0 m\u00e1y mu\u1ed1i',
      'Ship it \ud83d\ude80 \u2014 the line is green \u2705',
      'https://github.com/kiniena-github/jenify-os/pull/271',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSBzZWNyZXQ=',
      '/home/user/JENIFY-OS/docs/HEADQUARTER/PHASE_13_ADVANCED_RELIABILITY.md',
      'non\u00a0breaking space',
      'thin\u2009space',
      'an \u2013 en dash',
    ];
    const probe = probeWrite((ops) => {
      for (const [index, shape] of shapes.entries()) {
        const created = ops.createTask({
          capabilityId: READ_STATUS,
          payload: {},
          idempotencyKey: `sweep-${index}`,
          requestedBy: 'claude',
          title: shape,
          project: shape,
        });
        if (!created.ok) {
          return { ok: false, code: created.error.code, message: `createTask ${index}: ${created.error.message}` };
        }
        const posted = ops.postMissionMessage({
          threadId: 'room-build',
          author: 'founder',
          body: shape,
          refs: [shape],
        });
        if (!posted.ok) {
          return { ok: false, code: posted.error.code, message: `postMissionMessage ${index}: ${posted.error.message}` };
        }
      }
      return { ok: true, code: null, message: null };
    });
    expect(probe.message).toBe(null);
    expect(probe.accepted).toBe(true);
    expect(probe.brickedRoutes).toEqual([]);
  }, FILE_BACKED_PROBE_TIMEOUT_MS);
});

/* ------------------------------------------------------------------ */
/* Round thirteen: the six writes behind a helper, refusing at runtime. */
/* ------------------------------------------------------------------ */

describe('the writes the call graph found refuse a credential shape, and ordinary input still lands', () => {
  /**
   * In-memory rather than file-backed, deliberately.
   *
   * The file-backed probes above exist because those five writes BRICKED a
   * Founder read route, and only a fresh process over a real file proves an
   * outage survives a restart. These six never bricked a route: each unscanned
   * value was bounded by canonical truth before its write or landed only in
   * `op_evidence.payload`, which no control route serves. What has to be proven
   * here is the refusal itself, and the memory fixture proves that at a
   * hundredth of the cost.
   */
  it('reconciliationAuthorityRefusal refuses a credential-shaped actor and appends nothing', () => {
    const fx = setupFixture();
    const before = fx.db.prepare('SELECT COUNT(*) AS n FROM op_evidence').get() as { n: number };
    const message = fx.ops.reconciliationAuthorityRefusal(CREDENTIAL);
    expect(message).toContain('credential');
    const after = fx.db.prepare('SELECT COUNT(*) AS n FROM op_evidence').get() as { n: number };
    // The point of scanning BEFORE the helper: the audit append that used to
    // carry the credential does not happen at all.
    expect(after.n).toBe(before.n);
    // An ordinary actor still gets its real answer: `null` for a principal
    // holding approval authority, a refusal message for one that does not.
    expect(fx.ops.reconciliationAuthorityRefusal('founder')).toBe(null);
    expect(fx.ops.reconciliationAuthorityRefusal('analyst')).toContain('may not');
  });

  it('assignTaskAsFounder refuses a credential-shaped id before the founder gate audits it', () => {
    const fx = setupFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'jenify-os' },
        requestedBy: 'claude',
      }),
    );
    for (const [field, input] of [
      ['taskId', { taskId: CREDENTIAL, workerId: 'claude', founderId: 'founder' }],
      ['workerId', { taskId: created.task.id, workerId: CREDENTIAL, founderId: 'founder' }],
      ['founderId', { taskId: created.task.id, workerId: 'claude', founderId: CREDENTIAL }],
    ] as const) {
      const before = fx.db.prepare('SELECT COUNT(*) AS n FROM op_evidence').get() as { n: number };
      const result = fx.ops.assignTaskAsFounder(input);
      expect(result.ok, `${field} was accepted`).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message, `${field} is not named in the refusal`).toContain(field);
      const after = fx.db.prepare('SELECT COUNT(*) AS n FROM op_evidence').get() as { n: number };
      expect(after.n, `${field} reached the audit append`).toBe(before.n);
    }
  });

  it('assembleCollaborationContext refuses a credential-shaped requestedBy and appends nothing', () => {
    const fx = setupFixture();
    const before = fx.db.prepare('SELECT COUNT(*) AS n FROM op_evidence').get() as { n: number };
    const result = fx.ops.assembleCollaborationContext({
      sessionId: 'session-1',
      role: 'builder',
      requestedBy: CREDENTIAL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message).toContain('requestedBy');
    }
    const after = fx.db.prepare('SELECT COUNT(*) AS n FROM op_evidence').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('the two intelligence writes refuse a credential shape in every id they store', () => {
    const fx = setupFixture();
    for (const [field, input] of [
      [
        'taskId',
        { taskId: CREDENTIAL, workerId: 'claude', fence: 1, label: 'route', complexity: 'routine', contextSize: 'medium', workKind: 'coding' },
      ],
      [
        'workerId',
        { taskId: 'task-1', workerId: CREDENTIAL, fence: 1, label: 'route', complexity: 'routine', contextSize: 'medium', workKind: 'coding' },
      ],
      [
        'idempotencyKey',
        { taskId: 'task-1', workerId: 'claude', fence: 1, label: 'route', complexity: 'routine', contextSize: 'medium', workKind: 'coding', idempotencyKey: CREDENTIAL },
      ],
    ] as const) {
      const result = fx.ops.recordIntelligenceDecision(input as never);
      expect(result.ok, `recordIntelligenceDecision.${field} was accepted`).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message, `${field} is not named`).toContain(field);
    }
    for (const [field, input] of [
      ['decisionId', { decisionId: CREDENTIAL, workerId: 'claude', fence: 1, trigger: 'review_required' }],
      ['workerId', { decisionId: 'inteldec-1', workerId: CREDENTIAL, fence: 1, trigger: 'review_required' }],
      [
        'idempotencyKey',
        { decisionId: 'inteldec-1', workerId: 'claude', fence: 1, trigger: 'review_required', idempotencyKey: CREDENTIAL },
      ],
    ] as const) {
      const result = fx.ops.escalateIntelligenceDecision(input as never);
      expect(result.ok, `escalateIntelligenceDecision.${field} was accepted`).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message, `${field} is not named`).toContain(field);
    }
  });

  it('evaluateTaskEligibility refuses a credential-shaped taskId and records no routing evidence', () => {
    const fx = setupFixture();
    const before = fx.db.prepare('SELECT COUNT(*) AS n FROM op_evidence').get() as { n: number };
    const result = fx.ops.evaluateTaskEligibility(CREDENTIAL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message).toContain('taskId');
    }
    const after = fx.db.prepare('SELECT COUNT(*) AS n FROM op_evidence').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('the ordinary shape of each of the six still works', () => {
    const fx = setupFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'jenify-os' },
        requestedBy: 'claude',
      }),
    );
    // The advisory assignment, the eligibility read and the authority answer
    // all still do what they did — the guard refuses credentials, not work.
    //
    // `assignTaskAsFounder` needs the `hq.workforce_assign` trio this fixture
    // does not grant, so what is asserted is the one thing that matters here:
    // ordinary input reaches the FOUNDER GATE and is answered by it. A
    // `not_permitted` from the gate is the refusal this call always got; an
    // `invalid_input` would mean the new scan had started refusing work.
    const assigned = fx.ops.assignTaskAsFounder({
      taskId: created.task.id,
      workerId: 'claude',
      founderId: 'founder',
      rationale: 'closest to the change',
    });
    expect(assigned.ok).toBe(false);
    if (!assigned.ok) expect(assigned.error.code).toBe('not_permitted');
    expect(expectOk(fx.ops.evaluateTaskEligibility(created.task.id)).taskId).toBe(created.task.id);
    expect(fx.ops.reconciliationAuthorityRefusal('founder')).toBe(null);
    // And an unknown-but-ordinary id still gets the refusal it always got,
    // rather than the credential message.
    const unknown = fx.ops.assembleCollaborationContext({
      sessionId: 'session-1',
      role: 'builder',
      requestedBy: 'nobody',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).not.toBe('invalid_input');
  });
});
