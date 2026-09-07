/**
 * Phase 12 routes, end to end against the real canonical machinery.
 *
 * The five routes join the control API behind the SAME pipeline as every other
 * route — origin/referer gate, client-identity scan of body AND query, Founder
 * resolution, `safe()` on every response. What this suite proves:
 *
 *  - the write surface is exactly the three writes, and neither read is on it;
 *  - a signed-in non-Founder gets nothing, and a refused write changes no row;
 *  - a body that carries an actor is refused rather than re-attributed;
 *  - there is NO release, publish or deploy route, and reaching `released`
 *    through the lifecycle route touches no external-action table and says so
 *    in the response;
 *  - the unauthenticated artifact's new section carries counts over closed
 *    vocabularies and no product text of any kind.
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
import {
  PRODUCT_ARTIFACT_KINDS,
  PRODUCT_LIFECYCLE_STATES,
  PRODUCT_TYPES,
} from '../src/application/product-command.js';
import { externalActionCensus, productCensus, productFixture, type ProductFixture } from './product-factory.fixture.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-07T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

const MAP = [
  { realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' },
  { realmId: 'tenant-1', accountId: 'user-analyst', principalId: 'analyst' },
];

function account(accountId: string): AuthenticatedAccount {
  return { realmId: 'tenant-1', accountId, displayName: accountId, authenticatedAt: FRESH };
}
/** A signed-in account that is mapped to NO principal at all. */
const STAFF = account('user-staff');

interface Harness {
  fixture: ProductFixture;
  audit: ControlAuditEvent[];
  call(request: Partial<ControlRequest>, next?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null } = {}): Harness {
  const fixture = productFixture();
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
          ? { referer: `${ORIGIN}/hq/projects.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.products, headers, body: request.body, query: request.query },
        deps,
      );
    },
  };
}

function body(response: ControlResponse): Record<string, unknown> {
  return response.body;
}

describe('the route table states three writes and two reads', () => {
  it('puts exactly the writes on the write surface', () => {
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.products);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.productLifecycle);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.productArtifacts);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.productDetail);
  });

  it('offers no release, publish, deploy or distribute path at all', () => {
    // The phase's central negative, asserted against the whole route table
    // rather than against a list this test maintains.
    for (const path of Object.values(CONTROL_ROUTES)) {
      expect(path).not.toMatch(/release|publish|deploy|distribute|ship/i);
    }
    const h = harness();
    for (const invented of [
      '/api/hq/control/products/release',
      '/api/hq/control/products/publish',
      '/api/hq/control/products/deploy',
    ]) {
      for (const method of ['GET', 'POST'] as const) {
        const response = h.call({ method, path: invented, body: { productId: h.fixture.productId } });
        expect(response.status, `${method} ${invented}`).toBe(404);
      }
    }
  });

  it('answers nothing but GET on the two reads', () => {
    const h = harness();
    for (const path of [CONTROL_ROUTES.productDetail]) {
      for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
        const response = h.call({ method, path, body: {} });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
  });
});

describe('the Founder gate holds on every product route', () => {
  it('gives a signed-in non-Founder nothing, and leaks no product text', () => {
    const h = harness({ account: STAFF });
    const listed = h.call({ method: 'GET', path: CONTROL_ROUTES.products });
    expect(listed.status).toBe(403);
    expect(JSON.stringify(listed.body)).not.toContain('iridium');
    const written = h.call({
      method: 'POST',
      path: CONTROL_ROUTES.products,
      body: {
        projectId: h.fixture.projectId,
        productType: 'web',
        name: 'Sneak',
        problem: 'A problem',
        targetUsers: 'Users',
      },
    });
    expect(written.status).toBe(403);
    expect((h.fixture.db.prepare(`SELECT COUNT(*) AS n FROM hq_products`).get() as { n: number }).n).toBe(1);
  });

  it('refuses a body that supplies an actor rather than re-attributing it', () => {
    const h = harness();
    const before = productCensus(h.fixture);
    const response = h.call({
      method: 'POST',
      path: CONTROL_ROUTES.products,
      body: {
        projectId: h.fixture.projectId,
        productType: 'web',
        name: 'Impostor',
        problem: 'A problem',
        targetUsers: 'Users',
        requestedBy: 'analyst',
      },
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('client_identity_supplied');
    expect(productCensus(h.fixture)).toEqual(before);
  });

  it('attributes every write to the RESOLVED principal', () => {
    const h = harness();
    const created = h.call({
      method: 'POST',
      path: CONTROL_ROUTES.products,
      body: {
        projectId: h.fixture.projectId,
        productType: 'ai_workflow',
        name: 'niobium assistant',
        problem: 'A stated problem',
        targetUsers: 'Stated users',
      },
    });
    expect(created.status).toBe(201);
    const product = body(created).product as { createdBy: string; lifecycle: string };
    expect(product.createdBy).toBe('founder');
    expect(product.lifecycle).toBe('idea');
  });
});

describe('the register read is bounded, vocabulary-bearing and honest', () => {
  it('states the total, the store presence and the closed vocabularies', () => {
    const h = harness();
    const response = h.call({ method: 'GET', path: CONTROL_ROUTES.products });
    expect(response.status).toBe(200);
    const payload = body(response);
    expect(payload.total).toBe(1);
    expect(payload.truncated).toBe(false);
    expect(payload.storePresent).toBe(true);
    const vocabulary = payload.vocabulary as Record<string, string[]>;
    expect(vocabulary.productTypes).toEqual([...PRODUCT_TYPES]);
    expect(vocabulary.lifecycleStates).toEqual([...PRODUCT_LIFECYCLE_STATES]);
    expect(vocabulary.artifactKinds).toEqual([...PRODUCT_ARTIFACT_KINDS]);
    expect(String(payload.releaseGate)).toContain('Phase 8 gateway');
  });

  it('refuses an unknown lifecycle filter rather than ignoring it', () => {
    const h = harness();
    const response = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.products,
      query: { lifecycle: 'shipped' },
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { message: string }).message).toContain(PRODUCT_LIFECYCLE_STATES[0]!);
  });

  it('returns the plan template and the readiness observation on the detail read', () => {
    const h = harness();
    const response = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.productDetail,
      query: { productId: h.fixture.productId },
    });
    expect(response.status).toBe(200);
    const plan = body(response).plan as { grantsAuthority: boolean; createsNothing: boolean };
    const readiness = body(response).readiness as { authorizesRelease: boolean; blockers: unknown[] };
    expect(plan.grantsAuthority).toBe(false);
    expect(plan.createsNothing).toBe(true);
    expect(readiness.authorizesRelease).toBe(false);
    expect(readiness.blockers.length).toBeGreaterThan(0);
  });

  it('404s an unknown product without revealing whether anything else exists', () => {
    const h = harness();
    const response = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.productDetail,
      query: { productId: 'product-nope' },
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('iridium');
  });

  it('changes no row across the two reads', () => {
    const h = harness();
    const before = productCensus(h.fixture);
    h.call({ method: 'GET', path: CONTROL_ROUTES.products });
    h.call({
      method: 'GET',
      path: CONTROL_ROUTES.productDetail,
      query: { productId: h.fixture.productId },
    });
    expect(productCensus(h.fixture)).toEqual(before);
  });
});

describe('the lifecycle route records a state and performs no external action', () => {
  function move(h: Harness, to: string, expectedState?: string): ControlResponse {
    return h.call({
      method: 'POST',
      path: CONTROL_ROUTES.productLifecycle,
      body: { productId: h.fixture.productId, to, note: `Move to ${to}.`, expectedState },
    });
  }

  it('walks to released, states externalActionTaken: false, and touches no action table', () => {
    const h = harness();
    const before = externalActionCensus(h.fixture);
    let last: ControlResponse | null = null;
    for (const to of [
      'research',
      'specification',
      'architecture',
      'build',
      'test',
      'review',
      'release_candidate',
      'released',
    ]) {
      last = move(h, to);
      expect(last.status, to).toBe(200);
      expect(body(last).externalActionTaken, to).toBe(false);
    }
    expect((body(last!).product as { lifecycle: string }).lifecycle).toBe('released');
    expect(String(body(last!).releaseGate)).toContain('never an authorization');
    expect(externalActionCensus(h.fixture)).toEqual(before);
  });

  it('409s an illegal forward skip and writes nothing', () => {
    const h = harness();
    const before = productCensus(h.fixture);
    const response = move(h, 'released');
    expect(response.status).toBe(409);
    expect((response.body.error as { code: string }).code).toBe('invalid_product_lifecycle_move');
    expect(productCensus(h.fixture)).toEqual(before);
  });

  it('409s a stale expectedState', () => {
    const h = harness();
    expect(move(h, 'research').status).toBe(200);
    const response = move(h, 'specification', 'idea');
    expect(response.status).toBe(409);
    expect((response.body.error as { code: string }).code).toBe('product_lifecycle_conflict');
  });
});

describe('the artifact route appends versions and never edits one', () => {
  it('derives the version server-side and ignores any version a client sends', () => {
    const h = harness();
    const first = h.call({
      method: 'POST',
      path: CONTROL_ROUTES.productArtifacts,
      body: {
        productId: h.fixture.productId,
        kind: 'test_report',
        name: 'suite',
        locator: 'reports/suite-1.json',
        // A client-stated version is not a field this route reads.
        version: 99,
      },
    });
    expect(first.status).toBe(201);
    expect(body(first).version).toBe(1);
    const second = h.call({
      method: 'POST',
      path: CONTROL_ROUTES.productArtifacts,
      body: {
        productId: h.fixture.productId,
        kind: 'test_report',
        name: 'suite',
        locator: 'reports/suite-2.json',
        version: 99,
      },
    });
    expect(second.status).toBe(201);
    expect(body(second).version).toBe(2);
  });

  it('refuses an unknown artifact kind and a malformed digest', () => {
    const h = harness();
    const kind = h.call({
      method: 'POST',
      path: CONTROL_ROUTES.productArtifacts,
      body: { productId: h.fixture.productId, kind: 'binary', name: 'x', locator: 'y' },
    });
    expect(kind.status).toBe(400);
    const digest = h.call({
      method: 'POST',
      path: CONTROL_ROUTES.productArtifacts,
      body: {
        productId: h.fixture.productId,
        kind: 'build_artifact',
        name: 'bundle',
        locator: 'dist/bundle.tgz',
        contentDigest: 'nope',
      },
    });
    expect(digest.status).toBe(400);
    expect((digest.body.error as { message: string }).message).toContain('never verifies it');
  });

  it('refuses credential-shaped text before it is stored', () => {
    const h = harness();
    const before = productCensus(h.fixture);
    const response = h.call({
      method: 'POST',
      path: CONTROL_ROUTES.productArtifacts,
      body: {
        productId: h.fixture.productId,
        kind: 'source_package',
        name: 'bundle',
        locator: 'https://example.test/repo?token: ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
      },
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('unsafe_product_content');
    expect(productCensus(h.fixture)).toEqual(before);
  });
});

describe('what crosses to the unauthenticated artifact', () => {
  it('carries counts over closed vocabularies and no product text at all', () => {
    const h = harness();
    // Give the artifact something to be honest about.
    h.call({
      method: 'POST',
      path: CONTROL_ROUTES.productLifecycle,
      body: { productId: h.fixture.productId, to: 'research', note: 'Starting research.' },
    });
    const snapshot = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString() });
    const section = snapshot.productFactory;
    expect(section).toBeDefined();
    const data = section!.data;
    expect(data.storePresent).toBe(true);
    expect(data.products).toBe(1);
    expect(data.byLifecycle.research).toBe(1);
    expect(data.byType.web).toBe(1);
    expect(data.artifacts).toBe(1);
    expect(data.artifactsByKind.specification).toBe(1);

    // Nothing free-text from the register crosses: not a name, not a problem
    // statement, not a target user, not a locator, not a digest, not an id.
    const encoded = JSON.stringify(section);
    for (const secret of [
      'iridium',
      'Operators cannot see',
      'Operations staff',
      'docs/iridium-console-spec.md',
      'a'.repeat(64),
      h.fixture.productId,
      h.fixture.projectId,
      h.fixture.specArtifactId,
    ]) {
      expect(encoded, `the snapshot must not carry ${secret}`).not.toContain(secret);
    }
    // And no founder_only string from any earlier phase rides along either.
    for (const secret of ['obsidianfact', 'obsidianclaim', 'obsidianroom']) {
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    }
  });

  it('states the section keys exactly, so a future field is a deliberate act', () => {
    const h = harness();
    const snapshot = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString() });
    expect(Object.keys(snapshot.productFactory!.data).sort()).toEqual([
      'artifacts',
      'artifactsByKind',
      'byLifecycle',
      'byType',
      'note',
      'products',
      'storePresent',
    ]);
  });
});
