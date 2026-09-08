/**
 * Phase 14 SURFACES: the three control routes end to end against the real
 * canonical machinery, the `/session` fact, and the unauthenticated snapshot
 * section.
 *
 * What this suite proves:
 *
 *  - the three routes join the control API behind the SAME pipeline as every
 *    other route — origin/referer gate, client-identity scan of body AND
 *    query, Founder resolution, `safe()` on every response;
 *  - a signed-in account that the host's Founder MAP does not name gets
 *    nothing, and a refused write changes no row. The TRUE property, corrected
 *    in the Wave 5 correction round six (Low 5): this suite's non-Founder proof
 *    was only ever made against an UNMAPPED account, and "non-Founder" was the
 *    wrong word for what it proved. An account the map DOES name — `coo`, with
 *    approval authority but no intelligence grant — reaches the read and is
 *    correctly refused every write. That is the host's configuration decision,
 *    not a defect: the map is what the deployment declares a Founder-console
 *    principal to be, and `ResolvedFounder` is that declaration. Both halves are
 *    now tested, so the difference is a stated property rather than an
 *    unexamined one;
 *  - there is NO route that activates a provider, enables a paid service, buys
 *    anything, authorizes spend, records a routing decision, escalates one,
 *    records an outcome or records a cost — and no facade method sits behind
 *    an invented one;
 *  - the unauthenticated artifact's new section carries counts over closed
 *    vocabularies and NO amount, currency, ceiling, provider id, model id or
 *    free text of any kind;
 *  - the artifact still passes the fabricated-metric guard, which is the exact
 *    guard a cost phase is most likely to trip.
 */

import { describe, expect, it } from 'vitest';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  CONTROL_WRITE_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
import { assertBrowserSafe, assertNoFabricatedFields } from '../src/live/redaction.js';
import { expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import { CAPS } from './application.fixture.js';
import {
  INTELLIGENCE_COMMAND_CAPABILITY,
  INTELLIGENCE_TIERS,
  registerIntelligenceCommandCapability,
} from '../src/application/intelligence-command.js';
import {
  RELIABILITY_COMMAND_CAPABILITY,
  // The ONE `unrecognized` bucket, shared with Phase 13 rather than respelled.
  UNRECOGNIZED_BUCKET,
} from '../src/application/reliability-command.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-07T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

const MAP = [
  { realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' },
  { realmId: 'tenant-1', accountId: 'user-coo', principalId: 'coo' },
];

function account(accountId: string): AuthenticatedAccount {
  return { realmId: 'tenant-1', accountId, displayName: accountId, authenticatedAt: FRESH };
}
/** A signed-in account mapped to NO principal at all. */
const STAFF = account('user-staff');

interface Harness {
  fixture: ReturnType<typeof fileFixture>;
  audit: ControlAuditEvent[];
  call(request: Partial<ControlRequest>, next?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null } = {}): Harness {
  const fixture = fileFixture({ processIdentity: 'the-intel-surface-process' });
  registerIntelligenceCommandCapability(fixture.db);
  // The file fixture's Founder holds the reliability grant; add the
  // intelligence one beside it (the registry upserts).
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.openPr,
      RELIABILITY_COMMAND_CAPABILITY.id,
      INTELLIGENCE_COMMAND_CAPABILITY.id,
    ],
    approvalAuthority: true,
    active: true,
  });
  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null =
    options.account !== undefined ? options.account : account('user-founder');
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    founderMap: MAP,
    allowedOrigins: [ORIGIN],
    secretsEnv: {},
    sessions: { resolve: () => current },
    audit: { record: (event) => audit.push(event) },
    now: () => NOW,
  };
  return {
    fixture,
    audit,
    call(request, next) {
      if (next !== undefined) current = next;
      const method = request.method ?? 'GET';
      const headers: Record<string, string | undefined> =
        request.headers ??
        (method === 'GET'
          ? { referer: `${ORIGIN}/hq/index.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        {
          method,
          path: request.path ?? CONTROL_ROUTES.intelligence,
          headers,
          body: request.body,
          query: request.query,
        },
        deps,
      );
    },
  };
}

const OBSERVE_BODY = {
  providerId: 'anthropic',
  modelId: 'claude-generic',
  locality: 'cloud',
  availability: 'unknown',
  unitCostProvenance: 'unknown',
  unitCostUnitKind: 'unknown',
  source: 'founder_declared',
};

const BUDGET_BODY = {
  scopeKind: 'deployment',
  scopeId: 'deployment',
  window: 'total',
  ceilingMinorUnits: 100_000,
  currency: 'USD',
  permittedTiers: [...INTELLIGENCE_TIERS],
};

/** Record one decision and one cost entry through the FACADE (no route exists). */
function seedLedgers(h: Harness): string {
  expectOk(
    h.fixture.ops.setIntelligenceBudget({
      ...BUDGET_BODY,
      scopeKind: 'deployment',
      window: 'total',
      permittedTiers: [...INTELLIGENCE_TIERS],
      setBy: 'founder',
    }),
  );
  const decision = expectOk(
    h.fixture.ops.recordIntelligenceDecision({
      taskId: h.fixture.claim.taskId,
      workerId: 'claude',
      fence: h.fixture.claim.fence,
      label: 'open the release PR',
      complexity: 'routine',
      contextSize: 'medium',
      workKind: 'coding',
    }),
  ).decision;
  expectOk(
    h.fixture.ops.recordIntelligenceCost({
      taskId: h.fixture.claim.taskId,
      workerId: 'claude',
      fence: h.fixture.claim.fence,
      providerId: 'anthropic',
      provenance: 'unknown',
      unitKind: 'unknown',
      decisionId: decision.id,
      // A cost entry must DECLARE an identity, so a replay of the same
      // observation is recognized rather than counted twice (Wave 5 correction
      // round five, Low 3).
      idempotencyKey: 'surfaces-seed',
    }),
  );
  return decision.id;
}

describe('the intelligence READ', () => {
  it('answers the Founder with the posture, the ledgers, the analytics and the vocabularies', () => {
    const h = harness();
    try {
      const decisionId = seedLedgers(h);
      const response = h.call({});
      expect(response.status).toBe(200);
      const body = response.body;
      expect(body.ok).toBe(true);
      const posture = body.posture as Record<string, unknown>;
      expect(posture.storePresent).toBe(true);
      expect(posture.canActivatePaidProvider).toBe(false);
      expect(posture.canSpend).toBe(false);
      expect(posture.budgetStatement).toMatch(/never grants spend/);
      expect(body.decisionTotal).toBe(1);
      const decisions = body.decisions as Record<string, unknown>[];
      expect(decisions[0]!.id).toBe(decisionId);
      expect(decisions[0]!.grantsAuthority).toBe(false);
      expect(decisions[0]!.externalActionTaken).toBe(false);
      expect(body.costEntryTotal).toBe(1);
      expect(body.budgetTotal).toBe(1);
      expect((body.vocabulary as Record<string, unknown[]>).tiers).toEqual([...INTELLIGENCE_TIERS]);
      expect(body.canActivatePaidProvider).toBe(false);
      expect(body.canAuthorizeSpend).toBe(false);
      // An unknown cost reaches the Founder as null, never as zero.
      const entries = body.costEntries as { fact: { amountMinorUnits: number | null } }[];
      expect(entries[0]!.fact.amountMinorUnits).toBeNull();
    } finally {
      h.fixture.cleanup();
    }
  });

  it('is a pure read: it records nothing and activates nothing', () => {
    const h = harness();
    try {
      seedLedgers(h);
      const before = h.fixture.raw().prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get();
      const first = h.call({});
      const second = h.call({});
      expect(first.body.posture).toEqual(second.body.posture);
      expect(h.fixture.raw().prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get()).toEqual(before);
      expect(h.fixture.raw().prepare(`SELECT COUNT(*) AS n FROM hq_intel_decisions`).get()).toEqual({
        n: 1,
      });
    } finally {
      h.fixture.cleanup();
    }
  });

  it('tells a signed-in non-Founder nothing at all', () => {
    const h = harness({ account: STAFF });
    try {
      const response = h.call({});
      expect(response.status).toBe(403);
      expect(response.body.ok).toBe(false);
      expect(JSON.stringify(response.body)).not.toContain('ceilingMinorUnits');
    } finally {
      h.fixture.cleanup();
    }
  });

  /**
   * Wave 5 correction round six, Low 5 — the property the suite claimed and the
   * property it proved were different sentences.
   *
   * A MAPPED non-Founder is not the same thing as an unmapped account, and only
   * the unmapped case was ever tested. This pins what the mapped case actually
   * does, in both directions, so the disclosure boundary is a decision on the
   * record rather than a surprise.
   */
  it('lets a MAPPED non-Founder read, and refuses it every write', () => {
    const h = harness({ account: account('user-coo') });
    try {
      // The READ is allowed: `coo` is named by the host's Founder map, which is
      // what `ResolvedFounder` means. This is the true property.
      const read = h.call({});
      expect(read.status).toBe(200);
      expect(read.body.ok).toBe(true);
      // Every WRITE is refused, because a route write also takes the capability
      // grant and `coo` holds none.
      for (const [path, body] of [
        [CONTROL_ROUTES.intelligenceObserve, OBSERVE_BODY],
        [CONTROL_ROUTES.intelligenceBudget, BUDGET_BODY],
      ] as const) {
        const response = h.call({ method: 'POST', path, body });
        expect(response.status, path).toBe(403);
      }
      expect(h.fixture.ops.listModelObservationsBounded().total).toBe(0);
      expect(h.fixture.ops.listIntelligenceBudgetsBounded().total).toBe(0);
      // And an account the map does NOT name gets nothing at all — the half the
      // suite already proved, kept beside the half it did not.
      expect(h.call({}, STAFF).status).toBe(403);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('refuses an unauthenticated caller on all three routes', () => {
    const h = harness({ account: null });
    try {
      for (const path of [
        CONTROL_ROUTES.intelligence,
        CONTROL_ROUTES.intelligenceObserve,
        CONTROL_ROUTES.intelligenceBudget,
      ]) {
        const writes = CONTROL_WRITE_ROUTES.includes(path);
        const response = h.call({
          method: writes ? 'POST' : 'GET',
          path,
          body: writes ? {} : undefined,
        });
        expect(response.status, path).toBe(401);
        expect(response.body.ok, path).toBe(false);
      }
    } finally {
      h.fixture.cleanup();
    }
  });
});

describe('the two intelligence WRITES', () => {
  it('records an observation and states that it activates nothing', () => {
    const h = harness();
    try {
      const response = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.intelligenceObserve,
        body: OBSERVE_BODY,
      });
      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
      expect(response.body.activatesProvider).toBe(false);
      expect(response.body.externalActionTaken).toBe(false);
      expect(h.fixture.ops.listModelObservationsBounded().total).toBe(1);
      // An identical re-post dedupes onto the standing row with a 200.
      const again = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.intelligenceObserve,
        body: OBSERVE_BODY,
      });
      expect(again.status).toBe(200);
      expect(again.body.deduplicated).toBe(true);
      expect(h.fixture.ops.listModelObservationsBounded().total).toBe(1);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('sets a ceiling and states on the wire that it grants no spend', () => {
    const h = harness();
    try {
      const response = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.intelligenceBudget,
        body: BUDGET_BODY,
      });
      expect(response.status).toBe(201);
      expect(response.body.grantsSpend).toBe(false);
      expect(response.body.activatesPaidProvider).toBe(false);
      const budget = response.body.budget as Record<string, unknown>;
      expect(budget.version).toBe(1);
      expect(budget.ceilingMinorUnits).toBe(100_000);
      // And a second policy is a NEW VERSION, not an edit of the first.
      const second = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.intelligenceBudget,
        body: { ...BUDGET_BODY, ceilingMinorUnits: 200_000 },
      });
      expect((second.body.budget as Record<string, unknown>).version).toBe(2);
      expect(h.fixture.ops.listIntelligenceBudgetsBounded().total).toBe(2);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('refuses credential-shaped free text before anything is stored', () => {
    const h = harness();
    try {
      const response = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.intelligenceObserve,
        body: { ...OBSERVE_BODY, note: 'api_key: "sk-abcdefghijklmnop12345678"' },
      });
      expect(response.status).toBe(400);
      expect((response.body.error as { code: string }).code).toBe('unsafe_intelligence_content');
      expect(h.fixture.ops.listModelObservationsBounded().total).toBe(0);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('refuses a fabricated price at the route, and stores nothing', () => {
    const h = harness();
    try {
      const response = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.intelligenceObserve,
        body: {
          ...OBSERVE_BODY,
          unitCostProvenance: 'estimated',
          unitCostMinorUnits: 500,
          unitCostCurrency: 'USD',
          unitCostUnitKind: 'requests',
        },
      });
      expect(response.status).toBe(400);
      expect((response.body.error as { code: string }).code).toBe('cost_provenance_conflict');
      expect(h.fixture.ops.listModelObservationsBounded().total).toBe(0);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('lets a signed-in non-Founder write nothing, and changes no row', () => {
    const h = harness({ account: STAFF });
    try {
      for (const [path, body] of [
        [CONTROL_ROUTES.intelligenceObserve, OBSERVE_BODY],
        [CONTROL_ROUTES.intelligenceBudget, BUDGET_BODY],
      ] as const) {
        const response = h.call({ method: 'POST', path, body });
        expect(response.status, path).toBe(403);
      }
      expect(h.fixture.ops.listModelObservationsBounded().total).toBe(0);
      expect(h.fixture.ops.listIntelligenceBudgetsBounded().total).toBe(0);
    } finally {
      h.fixture.cleanup();
    }
  });
});

describe('what has NO route, and no facade method behind an invented one', () => {
  it('404s every path a spend- or execution-shaped control would live at', () => {
    const h = harness();
    try {
      for (const path of [
        '/api/hq/control/intelligence/activate',
        '/api/hq/control/intelligence/spend',
        '/api/hq/control/intelligence/purchase',
        '/api/hq/control/intelligence/credits',
        '/api/hq/control/intelligence/decisions',
        '/api/hq/control/intelligence/escalate',
        '/api/hq/control/intelligence/outcome',
        '/api/hq/control/intelligence/cost',
        '/api/hq/control/intelligence/route',
        '/api/hq/control/intelligence/model',
      ]) {
        for (const method of ['GET', 'POST'] as const) {
          const response = h.call({ method, path, body: method === 'POST' ? {} : undefined });
          expect(response.status, `${method} ${path}`).toBe(404);
        }
      }
    } finally {
      h.fixture.cleanup();
    }
  });

  it('spells no path SEGMENT anywhere in the control table that promises spend or activation', () => {
    const segments = Object.values(CONTROL_ROUTES)
      .flatMap((path) => path.split('/'))
      .filter(Boolean);
    for (const forbidden of ['activate', 'spend', 'purchase', 'buy', 'credits', 'billing', 'upgrade']) {
      expect(segments).not.toContain(forbidden);
    }
  });

  it('advertises the intelligence capability as a FACT, never as a spend button', () => {
    const h = harness();
    try {
      const response = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
      expect(response.status).toBe(200);
      const controls = response.body.controls as Record<string, unknown>;
      expect(controls.intelligenceCommand).toBe(true);
      // No flag anywhere promises spend or activation.
      expect(
        Object.keys(controls).filter((key) => /spend|activate|purchase|billing|credit/i.test(key)),
      ).toEqual([]);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('advertises it as FALSE when the capability is not granted', () => {
    const h = harness();
    try {
      h.fixture.principals.register({
        id: 'founder',
        displayName: 'Founder',
        originateCapabilities: [CAPS.readStatus, CAPS.openPr],
        approvalAuthority: true,
        active: true,
      });
      const response = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
      const controls = response.body.controls as Record<string, unknown>;
      expect(controls.intelligenceCommand).toBe(false);
    } finally {
      h.fixture.cleanup();
    }
  });
});

describe('the unauthenticated artifact', () => {
  it('carries counts over closed vocabularies and nothing that identifies anything', () => {
    const h = harness();
    try {
      seedLedgers(h);
      expectOk(
        h.fixture.ops.recordModelObservation({
          providerId: 'anthropic',
          modelId: 'claude-generic',
          locality: 'cloud',
          availability: 'healthy',
          unitCostProvenance: 'billed',
          unitCostMinorUnits: 123456,
          unitCostCurrency: 'USD',
          unitCostUnitKind: 'requests',
          source: 'provider_reported',
          observedBy: 'founder',
          note: 'invoice line 7',
        }),
      );
      const snapshot = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString() });
      const section = snapshot.intelligence!;
      expect(Object.keys(section.data).sort()).toEqual([
        'budgetsRecorded',
        'byCostProvenance',
        'byResult',
        'byState',
        'byTier',
        'costEntries',
        'decisions',
        'escalations',
        'note',
        'observations',
        'observationsWithKnownUnitCost',
        'observationsWithUnknownUnitCost',
        'storePresent',
        'tierPolicyRecorded',
        'unknownAmountEntries',
      ]);
      expect(section.data.decisions).toBe(1);
      expect(section.data.costEntries).toBe(1);
      expect(section.data.unknownAmountEntries).toBe(1);
      expect(section.data.observationsWithKnownUnitCost).toBe(1);
      expect(section.data.tierPolicyRecorded).toBe(true);

      const serialized = JSON.stringify(snapshot.intelligence);
      for (const forbidden of [
        '123456',
        'USD',
        'invoice line 7',
        'claude-generic',
        'anthropic',
        'open the release PR',
        h.fixture.claim.taskId,
        'deployment',
        '100000',
      ]) {
        expect(serialized, forbidden).not.toContain(forbidden);
      }
      // The provenance note names the unknown-amount count explicitly.
      expect(section.provenance.note).toMatch(/does not render an unknown cost as zero/);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('states an absent tier policy on the artifact rather than implying permission', () => {
    const h = harness();
    try {
      const snapshot = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString() });
      expect(snapshot.intelligence!.data.tierPolicyRecorded).toBe(false);
      expect(snapshot.intelligence!.provenance.note).toMatch(/free local\s+tier alone/);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('passes the browser-safety and fabricated-metric guards with a populated cost ledger', () => {
    // The fabricated-metric guard refuses a field literally named `cost`,
    // `spend`, `tokens` or `eta`. A cost phase is the most likely phase ever to
    // trip it, so it is asserted here on a populated artifact rather than
    // assumed.
    const h = harness();
    try {
      seedLedgers(h);
      const snapshot = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString() });
      expect(() => assertBrowserSafe(snapshot)).not.toThrow();
      expect(() => assertNoFabricatedFields(snapshot)).not.toThrow();
    } finally {
      h.fixture.cleanup();
    }
  });

  it('counts a forged tier as unrecognized without publishing its text', () => {
    const h = harness();
    try {
      seedLedgers(h);
      // An APPEND carrying a tier outside the closed vocabulary is
      // representable on an append-only table even though no facade path
      // produces one. It must count as `unrecognized` and its TEXT must not
      // reach the artifact.
      const raw = h.fixture.raw();
      raw
        .prepare(
          `INSERT INTO hq_intel_decisions
             (id, task_id, mission_id, project_id, tier, floor_tier, required_review_tier, escalated_from,
              escalation_trigger, bound_provider, characteristics, permitted_tiers, budget_decision, label,
              issued_at, issued_by, process_id, decision_key)
           VALUES (?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, '{}', '[]', 'within_ceiling', ?, ?, ?, ?, ?)`,
        )
        .run(
          'inteldec-forged',
          h.fixture.claim.taskId,
          'SUPER SECRET TIER NAME',
          'SUPER SECRET FLOOR',
          'SUPER SECRET LABEL',
          NOW.toISOString(),
          'nobody',
          'nobody',
          'forged-key',
        );
      const snapshot = liveSnapshotFromOperations(h.fixture.reopen('reader').ops, {
        now: NOW.toISOString(),
      });
      const serialized = JSON.stringify(snapshot.intelligence);
      expect(serialized).not.toContain('SUPER SECRET');
      expect(snapshot.intelligence!.data.byTier[UNRECOGNIZED_BUCKET]).toBe(1);
      expect(snapshot.intelligence!.data.decisions).toBe(2);
      const tierTotal = Object.values(snapshot.intelligence!.data.byTier).reduce((a, b) => a + b, 0);
      expect(tierTotal).toBe(snapshot.intelligence!.data.decisions);
    } finally {
      h.fixture.cleanup();
    }
  });
});

/**
 * Wave 5 correction round ten, HIGH 5 — the Phase-14 write/read asymmetry,
 * proved end to end on the route it bricks.
 *
 * `setIntelligenceBudget` scanned `{ note }` only, and its `scopeId` got
 * `canonicalBudgetScopeId` plus a length check. `recordModelObservation`
 * scanned `{ note, basis }`, and its `providerId`/`modelId` got only
 * `isIdentifierSlug` — whose `SLUG = /^[a-z0-9][a-z0-9._:-]*$/` admits `sk-…`
 * and `ghp_…` verbatim. Both tables are INSERT-only, the guard lived at the
 * HTTP boundary alone (`control-api.ts:4226` and `:4153`), and every in-process
 * FACADE caller went round it — so one accepted write permanently `500`-ed
 * `GET /intelligence` with no row to take back out.
 *
 * The sibling eleven lines away (`recordIntelligenceCost`) had the correct
 * guard the whole time — `assertBrowserSafe({ providerId, modelId })` — which
 * is NEW MEDIUM A: the fix is to apply the guard the file already had,
 * consistently, rather than to invent one.
 */
describe('a FACADE Phase-14 write cannot brick the Founder intelligence route', () => {
  const CREDENTIAL_SLUG = 'sk-abcdefghijklmnop0123456789';

  it('refuses a credential-shaped budget scopeId, and the route stays 200', () => {
    const h = harness();
    try {
      expect(h.call({}).status).toBe(200);
      const refused = h.fixture.ops.setIntelligenceBudget({
        ...BUDGET_BODY,
        scopeKind: 'provider',
        scopeId: CREDENTIAL_SLUG,
        window: 'total',
        permittedTiers: [...INTELLIGENCE_TIERS],
        setBy: 'founder',
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.error.code).toBe('invalid_input');
      expect(refused.error.message).toContain('credential shape');
      // The row the refusal did not write is the whole guarantee: the table is
      // INSERT-only, so an accepted write here is permanent.
      const after = h.call({});
      expect(after.status).toBe(200);
      expect(JSON.stringify(after.body)).not.toContain(CREDENTIAL_SLUG);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('refuses a credential-shaped observation providerId and modelId, and the route stays 200', () => {
    for (const attempt of [
      { providerId: CREDENTIAL_SLUG, modelId: 'claude-generic' },
      { providerId: 'anthropic', modelId: CREDENTIAL_SLUG },
    ]) {
      const h = harness();
      try {
        expect(h.call({}).status).toBe(200);
        const refused = h.fixture.ops.recordModelObservation({
          ...OBSERVE_BODY,
          ...attempt,
          locality: 'cloud',
          availability: 'unknown',
          unitCostProvenance: 'unknown',
          unitCostUnitKind: 'unknown',
          source: 'founder_declared',
          observedBy: 'founder',
        });
        expect(refused.ok, JSON.stringify(attempt)).toBe(false);
        if (refused.ok) throw new Error('unreachable');
        expect(refused.error.code).toBe('invalid_input');
        expect(refused.error.message).toContain('credential shape');
        const after = h.call({});
        expect(after.status, JSON.stringify(attempt)).toBe(200);
        expect(JSON.stringify(after.body)).not.toContain(CREDENTIAL_SLUG);
      } finally {
        h.fixture.cleanup();
      }
    }
  });

  it('an ordinary budget scope and model observation still land, and are still served', () => {
    // The guard refuses credential SHAPES, not identifiers — without this the
    // two tests above could be a refusal of everything.
    const h = harness();
    try {
      expectOk(
        h.fixture.ops.setIntelligenceBudget({
          ...BUDGET_BODY,
          scopeKind: 'provider',
          scopeId: 'anthropic',
          window: 'total',
          permittedTiers: [...INTELLIGENCE_TIERS],
          setBy: 'founder',
        }),
      );
      expectOk(
        h.fixture.ops.recordModelObservation({
          ...OBSERVE_BODY,
          locality: 'cloud',
          availability: 'unknown',
          unitCostProvenance: 'unknown',
          unitCostUnitKind: 'unknown',
          source: 'founder_declared',
          observedBy: 'founder',
        }),
      );
      expect(h.call({}).status).toBe(200);
    } finally {
      h.fixture.cleanup();
    }
  });
});
