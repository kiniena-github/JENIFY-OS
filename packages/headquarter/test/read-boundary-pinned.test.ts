/**
 * Wave 5, correction round seven — three enforcement lines that carried the
 * story and none of the proof.
 *
 * Each was verified UNPINNED by mutation against `ae4bf90` before this file was
 * written: the mutation was applied, the whole package suite was run, and it
 * stayed green at 178 files / 3288 tests.
 *
 *  - **MEDIUM 4 — `safe()` was completely unpinned.** `src/live/control-api.ts`
 *    wraps every control response in one `assertBrowserSafe` call, and that call
 *    is the READ half of the "write scan equals read scan" story the phase
 *    document tells. Neutering it changed no test. It is not decoration: with
 *    the scan disabled and a credential-shaped title in the store, `GET
 *    /command-center` SERVES the credential to the browser. The write half is
 *    now closed at the facade, so the only way to put such a row in front of the
 *    read boundary is a raw write — which is exactly the case the read boundary
 *    exists for, since HQ does not own every writer of its own file.
 *  - **MEDIUM 5 — the fail-closed default in `#entriesForScope` was
 *    unpinned.** Mutating `default: return false` to `return true` — an
 *    unrecognized budget scope matching EVERY cost entry — left the suite green.
 *    It is unreachable today, and that is a property of `isBudgetScope` at the
 *    boundary rather than of the switch, so both halves are pinned here: the
 *    boundary that refuses an unknown scope, and a derived assertion that every
 *    member of the scope vocabulary has a case, so a scope added without one
 *    falls through to a default that measures NOTHING rather than everything.
 *  - **MEDIUM 7 — a shipped claim of coverage that did not exist.** `PHASE_14`
 *    said a mapped non-Founder reading every Founder console route, including
 *    `founder_only` memory, "is now stated **and tested**". The behaviour is
 *    real and is reproduced here; the test was not. The only mapped-non-Founder
 *    test covered the intelligence routes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openHqDatabase } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { CONTROL_ROUTES, handleControlRequest } from '../src/live/control-api.js';
import { BUDGET_SCOPES } from '../src/application/intelligence-command.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  registerMemoryCommandCapability,
} from '../src/application/memory-command.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = join(PACKAGE_ROOT, 'src', 'application', 'service.ts');
const CONTROL_API = join(PACKAGE_ROOT, 'src', 'live', 'control-api.ts');

const CREDENTIAL = 'sk-ABCDEFGHIJKLMNOP0123456789';
const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-08-28T16:00:00.000Z');
const READ_STATUS = 'hq.read_status';
const ACCOUNT = {
  realmId: 'tenant',
  accountId: 'user',
  displayName: 'Founder',
  authenticatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
};

interface Opened {
  db: ReturnType<typeof openHqDatabase>;
  ops: HeadquarterOperations;
  store: HeadquarterStore;
}

function establish(dbPath: string): Opened {
  const db = openHqDatabase(dbPath);
  const store = new HeadquarterStore(db);
  const ops = new HeadquarterOperations(db, {
    store,
    policyCtx: { preApprovedCapabilities: new Set<string>([READ_STATUS]) },
  });
  return { db, ops, store };
}

function seed(opened: Opened): void {
  new CapabilityRegistry(opened.db).register({
    id: READ_STATUS,
    description: 'read',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  opened.store.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [READ_STATUS],
    active: true,
  });
  new HumanPrincipalRegistry(opened.db).register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [READ_STATUS],
    approvalAuthority: true,
    active: true,
  });
}

function readEveryControlRoute(ops: HeadquarterOperations): {
  route: string;
  status: number;
  body: string;
}[] {
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
  const seen: { route: string; status: number; body: string }[] = [];
  for (const route of Object.values(CONTROL_ROUTES)) {
    if (typeof route !== 'string') continue;
    const response = handleControlRequest(
      {
        method: 'GET',
        path: route,
        headers: { referer: `${ORIGIN}/hq/console.html`, host: 'hq.example' },
      },
      deps,
    );
    seen.push({ route, status: response.status, body: JSON.stringify(response.body ?? null) });
  }
  return seen;
}

describe('the READ boundary refuses what a raw writer put in front of it', () => {
  /**
   * The behaviour `safe()` is the whole of, executed rather than asserted from
   * the source. The facade now refuses a credential-shaped title, so the row is
   * written with RAW SQL — which is the case a read boundary exists for: the
   * write scan covers HQ's own writers and nothing covers the ones HQ does not
   * own.
   */
  it('answers 500 rather than serving a credential a raw writer stored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-read-boundary-'));
    const dbPath = path.join(dir, 'hq.sqlite');
    try {
      let taskId = '';
      {
        const opened = establish(dbPath);
        seed(opened);
        const created = opened.ops.createTask({
          capabilityId: READ_STATUS,
          payload: { branch: 'main' },
          idempotencyKey: 'read-boundary',
          requestedBy: 'claude',
          title: 'an ordinary title',
        });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error('unreachable');
        taskId = created.data.task.id;
        // The facade refuses this, which is the write half and is pinned
        // elsewhere. The read half has to be provable independently.
        expect(
          opened.ops.createTask({
            capabilityId: READ_STATUS,
            payload: { branch: 'other' },
            idempotencyKey: 'refused',
            requestedBy: 'claude',
            title: CREDENTIAL,
          }).ok,
        ).toBe(false);
        opened.db.close();
      }

      // Baseline: every shipped control route answers, and none carries the
      // credential, because it is not in the file yet.
      {
        const opened = establish(dbPath);
        const clean = readEveryControlRoute(opened.ops);
        expect(clean.length).toBeGreaterThan(0);
        expect(clean.filter((row) => row.status === 500)).toEqual([]);
        expect(clean.some((row) => row.body.includes(CREDENTIAL))).toBe(false);
        opened.db.close();
      }

      // The raw write the read boundary exists for.
      {
        const opened = establish(dbPath);
        opened.db
          .prepare(`UPDATE hq_op_task_meta SET title = ? WHERE task_id = ?`)
          .run(CREDENTIAL, taskId);
        opened.db.close();
      }

      // TWO fresh processes, because the outage this boundary prevents was
      // permanent: the routes that would have served it refuse instead, and
      // NOTHING anywhere carries the credential.
      for (const pass of ['first', 'second']) {
        const opened = establish(dbPath);
        const seen = readEveryControlRoute(opened.ops);
        const refused = seen.filter((row) => row.status === 500).map((row) => row.route);
        expect(refused.length, `${pass}: some route reads the stored title`).toBeGreaterThan(0);
        for (const row of seen) {
          expect(row.body.includes(CREDENTIAL), `${pass}: ${row.route} served the credential`).toBe(
            false,
          );
          if (row.status === 500) {
            expect(row.body, `${pass}: ${row.route}`).toContain('internal');
          }
        }
        opened.db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * And the boundary is ONE function every response goes through, so removing
   * it is one edit. The set of routes that skip it must be empty — derived from
   * the source, because a hand-kept list of "routes that are safe already" is
   * the same proxy this round is about.
   */
  it('routes every control response through the same guard, by enumeration', () => {
    const source = fs.readFileSync(CONTROL_API, 'utf8');
    // This module scans on the way IN at many sites — one per write route — and
    // on the way OUT at exactly one, which is the half that was unpinned. The
    // outbound scan is the one that reads `response.body`, and there must be
    // exactly one of it: a second would mean some responses take another path.
    const outbound = [...source.matchAll(/assertBrowserSafe\(\s*response\.body/g)];
    expect(outbound.length, 'the outbound browser guard has exactly one call site').toBe(1);
    // The inbound half is not this test's subject, but it must not vanish
    // either — `facade-write-scan.test.ts` owns its behaviour, this owns the
    // fact that it is still here.
    expect([...source.matchAll(/assertBrowserSafe\(/g)].length).toBeGreaterThan(1);
    const from = source.indexOf('function safe(response: ControlResponse): ControlResponse {');
    expect(from).toBeGreaterThan(-1);
    const body = source.slice(from, source.indexOf('\n}\n', from));
    expect(body).toContain("assertBrowserSafe(response.body, 'control')");
    expect(body).toContain("refusal(500, 'internal'");
    // The guard is not behind a condition: it runs on the way out of every
    // response, always.
    expect(body).not.toMatch(/if\s*\(/);
  });
});

describe('an unrecognized budget scope measures NOTHING, and cannot be named anyway', () => {
  it('refuses an unknown scope kind at the boundary that makes the default unreachable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-budget-scope-'));
    const dbPath = path.join(dir, 'hq.sqlite');
    try {
      const opened = establish(dbPath);
      seed(opened);
      for (const unknown of ['workspace', 'tenant', '', 'PROVIDER', 'deployment ']) {
        const answered = opened.ops.intelligenceBudgetDecision({
          scopeKind: unknown as (typeof BUDGET_SCOPES)[number],
          scopeId: 'anything',
          window: 'total',
        });
        expect(answered.ok, `scopeKind ${JSON.stringify(unknown)}`).toBe(false);
        if (!answered.ok) expect(answered.error.code).toBe('invalid_input');
      }
      // And every REAL member is accepted, so the refusal above is the
      // vocabulary and not an accident of validation order.
      for (const scope of BUDGET_SCOPES) {
        const answered = opened.ops.intelligenceBudgetDecision({
          scopeKind: scope,
          scopeId: 'anything',
          window: 'total',
        });
        expect(answered.ok, `scopeKind ${scope}`).toBe(true);
      }
      opened.db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The half a boundary check cannot reach. `#entriesForScope`'s `default` is a
   * FAIL-CLOSED default: an unrecognized scope matches no cost entry, so a
   * ceiling it might carry can never be reported as "within". Mutating it to
   * `return true` left the whole suite green, which means the property was
   * documented and unenforced.
   *
   * Derived rather than sampled: every member of the scope vocabulary must have
   * a case, so adding a scope without one falls to the default — and the default
   * must be the one that measures nothing.
   */
  it('covers every scope in the vocabulary, and defaults to matching none', () => {
    const source = fs.readFileSync(SERVICE, 'utf8');
    const from = source.indexOf('  #entriesForScope(');
    expect(from).toBeGreaterThan(-1);
    const to = source.indexOf('\n  }\n', from);
    expect(to).toBeGreaterThan(from);
    const body = source.slice(from, to);
    for (const scope of BUDGET_SCOPES) {
      expect(body, `${scope} has no case in #entriesForScope`).toContain(`case '${scope}':`);
    }
    const defaultAt = body.indexOf('default:');
    expect(defaultAt).toBeGreaterThan(-1);
    const defaultBody = body.slice(defaultAt, body.indexOf('}', defaultAt));
    expect(defaultBody).toContain('return false;');
    expect(defaultBody).not.toContain('return true;');
  });
});

/* ------------------------------------------------------------------ */
/* MEDIUM 7: the claim of coverage that had none.                      */
/* ------------------------------------------------------------------ */

/**
 * `PHASE_14` says a mapped non-Founder reads every Founder console route,
 * including `founder_only` memory, and that this "is now stated **and tested**".
 * The behaviour is real and deliberate — the host's Founder map is an authority
 * grant and says so — but no test asserted it: the only mapped-non-Founder test
 * covered the intelligence routes. A property the documentation calls tested and
 * that nothing tests is the same defect as a claim about a number nobody
 * counted, so it is asserted here, over the routes the sentence names.
 */
describe('a mapped non-Founder really does read every Founder console route', () => {
  it('serves a founder_only memory record in full to a mapped principal with no grants', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-mapped-reader-'));
    const dbPath = path.join(dir, 'hq.sqlite');
    const SECRET_TITLE = 'The acquisition target';
    const SECRET_BODY = 'Board-only: the counterparty is Mesob Holdings.';
    try {
      const opened = establish(dbPath);
      seed(opened);
      registerMemoryCommandCapability(opened.db);
      new HumanPrincipalRegistry(opened.db).register({
        id: 'founder',
        displayName: 'Founder',
        originateCapabilities: [READ_STATUS, MEMORY_COMMAND_CAPABILITY.id],
        approvalAuthority: true,
        active: true,
      });
      // A second principal, MAPPED by the host but holding nothing: no
      // approval authority, no originate grants at all.
      new HumanPrincipalRegistry(opened.db).register({
        id: 'coo',
        displayName: 'Chief of Staff',
        originateCapabilities: [],
        approvalAuthority: false,
        active: true,
      });
      const recorded = opened.ops.recordMemory({
        kind: 'decision',
        title: SECRET_TITLE,
        body: SECRET_BODY,
        project: 'corp',
        privacy: 'founder_only',
        requestedBy: 'founder',
      });
      if (!recorded.ok) throw new Error(`recordMemory refused: ${recorded.error.code} ${recorded.error.message}`);

      const deps = {
        ops: opened.ops,
        founderMap: [{ realmId: 'tenant', accountId: 'user-coo', principalId: 'coo' }],
        allowedOrigins: [ORIGIN],
        secretsEnv: {},
        sessions: {
          resolve: () => ({
            realmId: 'tenant',
            accountId: 'user-coo',
            displayName: 'Chief of Staff',
            authenticatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
          }),
        },
        credentials: { verify: () => 'ok' },
        audit: { record: () => {} },
        now: () => NOW,
      } as unknown as Parameters<typeof handleControlRequest>[1];

      const read = (path: string, query?: Record<string, string>) =>
        handleControlRequest(
          {
            method: 'GET',
            path,
            headers: { referer: `${ORIGIN}/hq/console.html`, host: 'hq.example' },
            query,
          },
          deps,
        );

      // The routes the shipped sentence names, one by one, so "every Founder
      // console route" is not itself a claim nobody checked.
      const memory = read(CONTROL_ROUTES.memory);
      expect(memory.status).toBe(200);
      expect(JSON.stringify(memory.body)).toContain(SECRET_BODY);

      const memorySearch = read(CONTROL_ROUTES.memorySearch, { text: 'acquisition' });
      expect(memorySearch.status).toBe(200);
      expect(JSON.stringify(memorySearch.body)).toContain(SECRET_TITLE);

      const search = read(CONTROL_ROUTES.search, { text: 'acquisition' });
      expect(search.status).toBe(200);
      expect(JSON.stringify(search.body)).toContain(SECRET_TITLE);

      // And a signed-in account the map does NOT name gets nothing, which is
      // what makes the map an authority grant rather than an accident.
      const unmapped = {
        ...(deps as unknown as Record<string, unknown>),
        founderMap: [],
      } as unknown as Parameters<typeof handleControlRequest>[1];
      const refused = handleControlRequest(
        {
          method: 'GET',
          path: CONTROL_ROUTES.memory,
          headers: { referer: `${ORIGIN}/hq/console.html`, host: 'hq.example' },
        },
        unmapped,
      );
      expect(refused.status).not.toBe(200);
      expect(JSON.stringify(refused.body ?? null)).not.toContain(SECRET_BODY);

      opened.db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
