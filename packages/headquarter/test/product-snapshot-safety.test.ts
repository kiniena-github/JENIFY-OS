/**
 * Phase 12's snapshot section, proved safe BY SHAPE against the ledger itself.
 *
 * The Product Factory's tables are append-only, and an APPEND is the write the
 * triggers deliberately permit. So the hostile input this suite uses is not a
 * patch and not a bypass — it is the ordinary, legal operation, followed by
 * the ordinary publication path. What is asserted:
 *
 *  - a row carrying free text in `to_state`, `product_type` or an artifact
 *    `kind` adds NO key to the unauthenticated artifact and corrupts no count;
 *  - the nested key sets are pinned on a POPULATED snapshot, not only on an
 *    empty one — an empty snapshot can never carry an injected key, so pinning
 *    it there proves nothing about the fold;
 *  - `productFactorySummary` reads through the private path, so a same-realm
 *    patch of `listProducts` (instance, prototype, and a facade constructed
 *    after the patch) moves nothing in the published section;
 *  - an unrecognised `product_type` reaches the route as a typed refusal
 *    rather than an uncaught throw and an opaque 500;
 *  - the forged state never reaches the Founder-gated search corpus either.
 */

import { describe, expect, it } from 'vitest';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import {
  PRODUCT_ARTIFACT_KINDS,
  PRODUCT_LIFECYCLE_STATES,
  PRODUCT_SNAPSHOT_UNRECOGNIZED,
  PRODUCT_TYPES,
} from '../src/application/product-command.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
import { productFixture, type ProductFixture } from './product-factory.fixture.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

/** Unique to this suite, so "did this string cross" stays decidable. */
const HOSTILE = 'PROJECT NIGHTINGALE — unannounced acquisition';
const HOSTILE_TYPE = 'PROJECT KESTREL — unannounced product line';
const HOSTILE_KIND = 'PROJECT MERLIN — unannounced artifact';

const NOW = '2026-09-07T16:00:00.000Z';
const ORIGIN = 'https://hq.example';

/** ONE legal append to the append-only lifecycle ledger. No UPDATE, no DELETE. */
function appendForgedEvent(fx: ProductFixture, toState: string): void {
  fx.db
    .prepare(
      `INSERT INTO hq_product_events (id, product_id, at, actor, kind, from_state, to_state, note, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `event-forged-${toState.slice(0, 8)}`,
      fx.productId,
      '2026-09-07T15:00:00.000Z',
      'founder',
      'lifecycle_moved',
      'idea',
      toState,
      'A legal append carrying free text.',
      null,
    );
}

/** ONE legal insert into the product register, carrying a forged type. */
function appendForgedProduct(fx: ProductFixture, productType: string): string {
  const id = 'product-forged';
  fx.db
    .prepare(
      `INSERT INTO hq_products
         (id, project_id, product_type, name, problem, target_users, summary,
          idempotency_key, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      fx.projectId,
      productType,
      'forged product',
      'A forged problem statement.',
      'Forged users',
      null,
      'idempotency-forged',
      'founder',
      '2026-09-07T15:05:00.000Z',
    );
  return id;
}

function appendForgedArtifact(fx: ProductFixture, kind: string): void {
  fx.db
    .prepare(
      `INSERT INTO hq_product_artifacts
         (id, product_id, kind, name, version, locator, content_digest,
          digest_provenance, record_digest, note, recorded_by, recorded_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'artifact-forged',
      fx.productId,
      kind,
      'forged artifact',
      99,
      'docs/forged.md',
      null,
      'not_provided',
      'f'.repeat(64),
      null,
      'founder',
      '2026-09-07T15:06:00.000Z',
      'idempotency-artifact-forged',
    );
}

function section(fx: ProductFixture): Record<string, unknown> {
  return liveSnapshotFromOperations(fx.ops, { now: NOW }).productFactory!.data as unknown as Record<
    string,
    unknown
  >;
}

function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

const EXPECTED_TYPE_KEYS = [...PRODUCT_TYPES, PRODUCT_SNAPSHOT_UNRECOGNIZED].sort();
const EXPECTED_LIFECYCLE_KEYS = [...PRODUCT_LIFECYCLE_STATES, PRODUCT_SNAPSHOT_UNRECOGNIZED].sort();
const EXPECTED_KIND_KEYS = [...PRODUCT_ARTIFACT_KINDS, PRODUCT_SNAPSHOT_UNRECOGNIZED].sort();

/** Every count is a real number — an absent key would fold to NaN, which JSON writes as null. */
function everyCountIsANumber(map: unknown): boolean {
  return Object.values(map as Record<string, unknown>).every(
    (count) => typeof count === 'number' && Number.isInteger(count),
  );
}

describe('a legal append cannot add a key to the unauthenticated artifact', () => {
  it('pins the NESTED key sets on a POPULATED snapshot built from hostile rows', () => {
    const fx = productFixture();
    appendForgedEvent(fx, HOSTILE);
    appendForgedProduct(fx, HOSTILE_TYPE);
    appendForgedArtifact(fx, HOSTILE_KIND);

    const view = section(fx);
    // Not an empty snapshot: this one carries two products and two artifacts,
    // one of each forged. The key sets are still a function of the closed
    // vocabularies and nothing else.
    expect(view.products).toBe(2);
    expect(view.artifacts).toBe(2);
    expect(keysOf(view)).toEqual([
      'artifacts',
      'artifactsByKind',
      'byLifecycle',
      'byType',
      'note',
      'products',
      'storePresent',
    ]);
    expect(keysOf(view.byType)).toEqual(EXPECTED_TYPE_KEYS);
    expect(keysOf(view.byLifecycle)).toEqual(EXPECTED_LIFECYCLE_KEYS);
    expect(keysOf(view.artifactsByKind)).toEqual(EXPECTED_KIND_KEYS);
  });

  it('carries no forged string anywhere on the whole artifact', () => {
    const fx = productFixture();
    appendForgedEvent(fx, HOSTILE);
    appendForgedProduct(fx, HOSTILE_TYPE);
    appendForgedArtifact(fx, HOSTILE_KIND);
    const encoded = JSON.stringify(liveSnapshotFromOperations(fx.ops, { now: NOW }));
    for (const forged of [HOSTILE, HOSTILE_TYPE, HOSTILE_KIND, 'NIGHTINGALE', 'KESTREL', 'MERLIN']) {
      expect(encoded, `the artifact must not carry ${forged}`).not.toContain(forged);
    }
  });

  it('keeps the counts honest instead of turning one into null', () => {
    // The old failure mode, stated exactly: `+= 1` on a key the empty
    // snapshot never created is NaN, and JSON.stringify writes NaN as null —
    // so the injection corrupted the counts as well as leaking the text.
    const fx = productFixture();
    appendForgedEvent(fx, HOSTILE);
    appendForgedProduct(fx, HOSTILE_TYPE);
    appendForgedArtifact(fx, HOSTILE_KIND);

    const view = section(fx);
    for (const map of ['byType', 'byLifecycle', 'artifactsByKind']) {
      expect(everyCountIsANumber(view[map]), map).toBe(true);
    }
    const sum = (map: unknown): number =>
      Object.values(map as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum(view.byType)).toBe(view.products);
    expect(sum(view.byLifecycle)).toBe(view.products);
    expect(sum(view.artifactsByKind)).toBe(view.artifacts);

    // The forged rows are counted as what HQ actually knows about them.
    expect((view.byType as Record<string, number>)[PRODUCT_SNAPSHOT_UNRECOGNIZED]).toBe(1);
    expect((view.artifactsByKind as Record<string, number>)[PRODUCT_SNAPSHOT_UNRECOGNIZED]).toBe(1);
    // The forged EVENT is not a move at all, so the real product is still at
    // `idea` — an unrecognised state is not a lifecycle the register adopts.
    expect((view.byLifecycle as Record<string, number>).idea).toBe(2);
    expect((view.byLifecycle as Record<string, number>)[PRODUCT_SNAPSHOT_UNRECOGNIZED]).toBe(0);
    expect(view.note).toContain('unrecognized');
  });
});

describe('the published section reads through the private path', () => {
  it('is unmoved by a patched listProducts on the instance, the prototype and a later facade', () => {
    const fx = productFixture();
    const honest = JSON.stringify(section(fx));
    const forgedRecord = {
      id: 'product-ghost',
      projectId: fx.projectId,
      productType: HOSTILE_TYPE,
      name: 'ghost',
      problem: HOSTILE,
      targetUsers: HOSTILE,
      summary: null,
      createdBy: 'founder',
      createdAt: '2026-09-07T15:00:00.000Z',
      lifecycle: HOSTILE,
      lifecycleChangedAt: null,
      lifecycleChangedBy: null,
      lifecycleStatement: '',
      authority: {
        riskClass: null,
        founderOnly: true,
        approvalFlow: 'originate_gated_no_approval_row',
        executesExternally: false,
      },
      artifacts: [],
      artifactTotal: 0,
      history: [],
    };
    const prototype = Object.getPrototypeOf(fx.ops) as { listProducts: () => unknown[] };
    prototype.listProducts = () => [forgedRecord as never, forgedRecord as never];
    (fx.ops as unknown as { listProducts: () => unknown[] }).listProducts = () => [
      forgedRecord as never,
      forgedRecord as never,
      forgedRecord as never,
    ];
    try {
      // The lie TOOK on the public surface — otherwise this proves nothing.
      expect(fx.ops.listProducts()).toHaveLength(3);
      const fresh = new HeadquarterOperations(fx.db, { store: new HeadquarterStore(fx.db) });
      expect(fresh.listProducts()).toHaveLength(2);
      expect((fresh.listProducts()[0] as { lifecycle: string }).lifecycle).toBe(HOSTILE);

      // And it moves nothing in the published section, on either facade.
      for (const ops of [fx.ops, fresh]) {
        const published = liveSnapshotFromOperations(ops, { now: NOW }).productFactory!.data;
        expect(JSON.stringify(published)).toBe(honest);
        expect(JSON.stringify(published)).not.toContain('NIGHTINGALE');
        expect(JSON.stringify(published)).not.toContain('KESTREL');
      }
    } finally {
      delete (prototype as { listProducts?: unknown }).listProducts;
      delete (fx.ops as unknown as { listProducts?: unknown }).listProducts;
    }
  });
});

describe('an unrecognised product type is a stated refusal, not a 500', () => {
  function routeHarness(fx: ProductFixture): {
    audit: ControlAuditEvent[];
    call(request: Partial<ControlRequest>): ControlResponse;
  } {
    const audit: ControlAuditEvent[] = [];
    const deps: ControlApiDeps = {
      ops: fx.ops,
      founderMap: [{ realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' }],
      allowedOrigins: [ORIGIN],
      secretsEnv: {},
      sessions: {
        resolve: (): AuthenticatedAccount => ({
          realmId: 'tenant-1',
          accountId: 'user-founder',
          displayName: 'Founder',
          authenticatedAt: '2026-09-07T15:59:00.000Z',
        }),
      },
      audit: { record: (event) => audit.push(event) },
      now: () => new Date(NOW),
    };
    return {
      audit,
      call: (request) =>
        handleControlRequest(
          {
            method: 'GET',
            path: request.path ?? CONTROL_ROUTES.productDetail,
            headers: { referer: `${ORIGIN}/hq/projects.html`, host: 'hq.example' },
            query: request.query,
          },
          deps,
        ),
    };
  }

  it('answers 400 unrecognized_product_type and names the recognized vocabulary', () => {
    const fx = productFixture();
    const forgedId = appendForgedProduct(fx, HOSTILE_TYPE);
    const h = routeHarness(fx);
    const response = h.call({ query: { productId: forgedId } });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('unrecognized_product_type');
    expect((response.body.error as { message: string }).message).toContain('backend_service');
    expect(h.audit.at(-1)!.outcome).toBe('refused');
    expect(h.audit.at(-1)!.detail).toBe('unrecognized_product_type');
    // The refusal states the reason without quoting the forged text back.
    expect(JSON.stringify(response.body)).not.toContain('KESTREL');
  });

  it('still answers the ordinary detail read for a genuine product', () => {
    const fx = productFixture();
    appendForgedProduct(fx, HOSTILE_TYPE);
    const h = routeHarness(fx);
    const response = h.call({ query: { productId: fx.productId } });
    expect(response.status).toBe(200);
    expect((response.body.plan as { templateId: string }).templateId).toBe('template.web.v1');
  });
});

describe('the forged state never reaches the Founder-gated corpus either', () => {
  it('indexes the product at its last genuine lifecycle', () => {
    const fx = productFixture();
    appendForgedEvent(fx, HOSTILE);
    const result = fx.ops.searchCompany({ text: 'iridium' }, { includeFounderOnly: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const products = result.data.hits.filter((hit) => hit.document.source === 'product');
    expect(products).toHaveLength(1);
    expect(products[0]!.document.status).toBe('idea');
    expect(JSON.stringify(result.data)).not.toContain('NIGHTINGALE');
  });
});
