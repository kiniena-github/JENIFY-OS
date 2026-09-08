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

import { describe, expect, it } from 'vitest';
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
 * Parameter names that carry FREE TEXT a caller composes. Not an exhaustive
 * theory of naming — a curated set drawn from the parameters the facade
 * actually declares, which is why the enumeration test below also prints what
 * it found when it fails.
 */
const FREE_TEXT_PARAMETERS: readonly string[] = [
  'note',
  'reason',
  'rationale',
  'title',
  'body',
  'statement',
  'limitations',
  'label',
  'purpose',
  'displayName',
  'summary',
  'basis',
  'instruction',
  'message',
  'description',
  'vendor',
  'text',
  'question',
];

/**
 * The ONE piece of caller text a facade write deliberately does not scan: the
 * task PAYLOAD handed to `createTask`. Recorded here, and executed at the
 * bottom of this file rather than merely claimed.
 *
 * No control route serves a task payload — probed across every shipped route,
 * and a payload carrying a credential shape bricked none while the same shape
 * in the title bricked two. The queue applies the evidence log's own heuristic
 * to it at `enqueue`, and the strict guard for it lives at the boundary that
 * would PUBLISH it: the dispatch lane, which refuses to open an issue carrying
 * one. `claude-dispatch.test.ts` and `dispatch-durable-label.test.ts` reach
 * that boundary by writing a credential-shaped payload through `createTask` on
 * purpose, precisely to prove the dispatch guard holds INDEPENDENTLY of the
 * submission guard. Scanning the payload here would delete that
 * defence-in-depth proof, so the payload stays with the guard that owns it.
 * `createTask`'s `title` and `project` ARE scanned.
 */

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

interface TextWrite {
  name: string;
  parameters: string[];
  scanned: boolean;
}

/** Every public facade method that writes and declares a free-text parameter. */
function textStoringWrites(): TextWrite[] {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const classStart = lines.findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  expect(classStart).toBeGreaterThan(-1);
  const starts: { name: string; line: number }[] = [];
  for (let i = classStart; i < lines.length; i += 1) {
    const match = /^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]);
    if (match && !CONTROL_WORDS.has(match[1])) starts.push({ name: match[1], line: i });
  }
  const found: TextWrite[] = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k].line;
    const to = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    const name = starts[k].name;
    if (name.startsWith('#')) continue;
    const body = lines.slice(from, to).join('\n');
    if (!WRITE_MARKERS.test(body)) continue;
    // The declared parameter list: from the method name to the line that
    // closes its parentheses, counted rather than guessed, so a multi-line
    // inline object type is read whole.
    let depth = 0;
    let opened = false;
    let signatureEnd = from;
    for (let i = from; i < to; i += 1) {
      for (const character of lines[i]) {
        if (character === '(') {
          depth += 1;
          opened = true;
        } else if (character === ')') {
          depth -= 1;
        }
      }
      if (opened && depth === 0) {
        signatureEnd = i;
        break;
      }
    }
    const signature = lines.slice(from, signatureEnd + 1).join('\n');
    const parameters = FREE_TEXT_PARAMETERS.filter((parameter) =>
      new RegExp(`(^|[^A-Za-z0-9_])${parameter}\\??\\s*[:,)]`).test(signature),
    );
    if (parameters.length === 0) continue;
    found.push({ name, parameters, scanned: body.includes('assertNoCredentialShape') });
  }
  return found;
}

describe('every facade write that stores caller text passes it through the one scan', () => {
  it('finds the text-storing writes at all — the enumeration is not vacuous', () => {
    const writes = textStoringWrites();
    expect(writes.length).toBeGreaterThan(30);
    const names = writes.map((w) => w.name);
    // The five the round-seven correction closed, plus a sample of the ones
    // round four already had. If the parameter vocabulary ever stops matching
    // the facade, this is what notices.
    for (const name of [
      'failTask',
      'registerExecutionWorker',
      'engageKillSwitch',
      'promoteProposal',
      'recordTruth',
      'recordMemory',
      'reconcileRun',
    ]) {
      expect(names, `${name} is no longer recognised as a text-storing write`).toContain(name);
    }
  });

  it('no text-storing write reaches storage unscanned', () => {
    const unscanned = textStoringWrites()
      .filter((w) => !w.scanned)
      .map((w) => `${w.name}(${w.parameters.join(', ')})`);
    expect(unscanned).toEqual([]);
  });

  it('createTask scans, even though its parameters arrive inside a named input type', () => {
    // Its signature is `createTask(input: CreateTaskInput)`, so the parameter
    // scan above cannot see `title` and `project`. Asserted directly instead,
    // because these are two of the five columns the outage was found on.
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
}

/**
 * Attempt one write carrying a credential shape, then read every shipped
 * control route from two SEPARATE processes over the same file. Two processes
 * because the original defect was permanent, not transient: the first outage
 * proved the row was served, the second proved a restart did not clear it.
 */
function probeWrite(act: (ops: HeadquarterOperations) => { ok: boolean; code: string | null }): WriteProbe {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-write-scan-'));
  const dbPath = path.join(dir, 'hq.sqlite');
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
    {
      const { db, ops, store } = open();
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
      const outcome = act(ops);
      accepted = outcome.ok;
      code = outcome.code;
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
    return { brickedRoutes: [...bricked].sort(), accepted, code };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function refusal(result: { ok: boolean; error?: { code: string } }): {
  ok: boolean;
  code: string | null;
} {
  return { ok: result.ok, code: result.ok ? null : (result.error?.code ?? null) };
}

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
  });

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
  });

  it('failTask refuses a credential-shaped reason, and no route is bricked', () => {
    const probe = probeWrite((ops) => {
      const created = ops.createTask({
        capabilityId: READ_STATUS,
        payload: { branch: 'main' },
        idempotencyKey: 'k1',
        requestedBy: 'claude',
      });
      if (!created.ok) return { ok: true, code: null };
      const claimed = ops.claimNext('claude', READ_STATUS, undefined, created.data.task.id);
      if (!claimed.ok) return { ok: true, code: null };
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
  });

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
  });

  it('engageKillSwitch refuses a credential-shaped reason, and no route is bricked', () => {
    const probe = probeWrite((ops) =>
      refusal(ops.engageKillSwitch('global', 'founder', `stop everything: ${CREDENTIAL}`)),
    );
    expect(probe.accepted).toBe(false);
    expect(probe.code).toBe('invalid_input');
    expect(probe.brickedRoutes).toEqual([]);
  });

  it('the fail-safe act still works with an ordinary reason — the guard refuses credentials, not stopping', () => {
    const probe = probeWrite((ops) =>
      refusal(ops.engageKillSwitch('global', 'founder', 'Suspected credential leak in the pipeline.')),
    );
    expect(probe.accepted).toBe(true);
    expect(probe.brickedRoutes).toEqual([]);
  });

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
  });

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
  });
});
