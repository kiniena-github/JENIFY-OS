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
 */

/**
 * The one string parameter of a method the write-marker scan reaches that does
 * not go through the scan, and why.
 *
 * `lookupPrincipal(id)` is a READ — `return this.#principalOf(id)` is its whole
 * body — and the phase document's LEFT-AVAILABLE table already says so in the
 * same words. It is reached here only because the write-marker regex matches
 * text in the documentation block above it. It stores nothing, so there is
 * nothing for a credential shape to be stored in.
 */
const EXEMPT_PARAMETERS: readonly string[] = ['lookupPrincipal.id'];

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

const WRITE_MARKERS =
  /(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)|appendEvidence\(|appendEvent\(|#upsertMeta\(|#requirePrivilegedQueue\(\)|postMessage\(|registry\.(?:register|disable|setHealth|assign|update)\(|#workerProviderRegistrar\.|#appendRunEvent\(|this\.queue\.(?:start|heartbeat|complete|fail|claim)\(/;

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
 * Every (facade write, string parameter) pair, with whether the parameter
 * reaches a scan. Derived from the source; no curated parameter vocabulary
 * takes part.
 */
function facadeWriteParameters(): ParameterFact[] {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const classStart = lines.findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  expect(classStart).toBeGreaterThan(-1);
  const starts: { name: string; line: number }[] = [];
  for (let i = classStart; i < lines.length; i += 1) {
    const match = /^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]);
    if (match && !CONTROL_WORDS.has(match[1])) starts.push({ name: match[1], line: i });
  }
  const facts: ParameterFact[] = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k].line;
    const to = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    const name = starts[k].name;
    if (name.startsWith('#')) continue;
    const body = lines.slice(from, to).join('\n');
    if (!WRITE_MARKERS.test(body)) continue;
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
      // from the signature text itself.
      for (const field of signature.matchAll(
        /(?:^|[{;,\n])\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:\s*((?:readonly\s+)?string(?:\[\])?(?:\s*\|\s*null)?(?:\s*\|\s*undefined)?)\s*[;,\n)]/g,
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
    for (const parameter of new Set(parameters)) {
      facts.push({
        method: name,
        parameter,
        covered:
          !carvedOut.has(parameter) &&
          (wholeInput || explicit.has(parameter) || generic.has(parameter)),
      });
    }
  }
  return facts;
}

/** The string fields of a NAMED input interface declared in the same file. */
function namedInputStringFields(parameterName: string, signature: string): string[] {
  const named = new RegExp(`\\b${parameterName}\\s*:\\s*([A-Z][A-Za-z0-9_]*)`).exec(signature);
  if (!named) return [];
  const source = fs.readFileSync(SERVICE, 'utf8');
  const at = source.indexOf(`export interface ${named[1]} {`);
  if (at < 0) return [];
  const end = source.indexOf('\n}\n', at);
  const declaration = source.slice(at, end);
  return [
    ...declaration.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:\s*(?:readonly\s+)?string\b/gm),
  ].map((m) => m[1]);
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
    expect(facts.length).toBeGreaterThan(200);
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

  it('names every deliberately unscanned field, and there is exactly one', () => {
    // DERIVED, not written down (Wave 5 correction round eleven, Medium 1).
    // The sentence "there is exactly one carve-out" was false at the previous
    // head — `createTask.payload`, `submitResult.evidenceRefs` and
    // `postMissionMessage.refs` were all unscanned — because two of the three
    // were exempted by a type filter nobody had to name. An exemption is now a
    // literal at the call site, so it can be counted.
    expect(deliberatelyUnscannedFields()).toEqual(['createTask.payload']);
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
 * would relax the deadline for all 3425 tests in this package, including the
 * many where a hang is the real signal. Only the harness deadline changes here;
 * every assertion is untouched.
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
