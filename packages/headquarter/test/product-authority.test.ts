/**
 * Phase 12 against the real canonical machinery.
 *
 * What these suites are for, in the order they appear:
 *  - a product REFERENCES a canonical project, and cannot exist against a
 *    forged, absent or closed one — proven with the public project reads
 *    PATCHED to invent the project, so the refusal cannot be coming from a
 *    read an attacker controls;
 *  - the Founder gate and the capability trio fail closed, exactly as they do
 *    for missions, projects, memory and truth;
 *  - artifact versions are immutable AT THE ENGINE: UPDATE, DELETE, REPLACE
 *    and UPSERT are all refused by SQLite itself, on all three tables;
 *  - the lifecycle is derived from the append-only ledger, so a patched
 *    public read cannot buy an illegal move;
 *  - a lifecycle move — including to release_candidate and released — writes
 *    one event row and touches NO external-action table;
 *  - a template creates nothing, and the canonical mission path still applies
 *    its own gate to a template-derived mission;
 *  - products and artifacts are searchable through the Phase 11 registry, and
 *    the founder_only isolation that registry already had is unchanged.
 */

import { describe, expect, it } from 'vitest';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { expectOk } from './application.fixture.js';
import { leaksPrivateString } from './search-ask.fixture.js';
import {
  advanceTo,
  externalActionCensus,
  productCensus,
  productFixture,
  type ProductFixture,
} from './product-factory.fixture.js';
import { PRODUCT_COMMAND_CAPABILITY } from '../src/application/product-command.js';

function errorOf(result: { ok: boolean; error?: { code: string; message: string } }): {
  code: string;
  message: string;
} {
  if (result.ok) throw new Error('expected a refusal');
  return result.error!;
}

function rows(fx: ProductFixture, table: string): number {
  return (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/* ------------------------------------------------------------------ */

describe('a product references a canonical project and cannot forge one', () => {
  it('registers against a real, open register entry and names it', () => {
    const fx = productFixture();
    const product = fx.ops.getProduct(fx.productId)!;
    expect(product.projectId).toBe(fx.projectId);
    // The reference RESOLVES: the id names a real row in hq_projects.
    const row = fx.db
      .prepare(`SELECT id, name FROM hq_projects WHERE id = ?`)
      .get(product.projectId) as { id: string; name: string } | undefined;
    expect(row?.id).toBe(fx.projectId);
    expect(row!.name).toContain('palladium');
    // And the product did NOT become a project: the register is untouched.
    expect(rows(fx, 'hq_projects')).toBe(2);
  });

  it('refuses an absent project and writes nothing', () => {
    const fx = productFixture();
    const before = productCensus(fx);
    const refused = fx.ops.createProduct({
      projectId: 'project-does-not-exist',
      productType: 'web',
      name: 'Ghost',
      problem: 'A problem',
      targetUsers: 'Users',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('unknown_project');
    expect(errorOf(refused).message).toContain('never creates or stands in for one');
    expect(productCensus(fx)).toEqual(before);
  });

  it('refuses a CLOSED project rather than reopening it', () => {
    const fx = productFixture();
    const before = productCensus(fx);
    const refused = fx.ops.createProduct({
      projectId: fx.closedProjectId,
      productType: 'web',
      name: 'Late arrival',
      problem: 'A problem',
      targetUsers: 'Users',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('project_closed');
    expect(productCensus(fx)).toEqual(before);
    // The closed project stayed closed — a refusal never repairs the world.
    expect(fx.ops.getProject(fx.closedProjectId)!.status).toBe('closed');
  });

  it('is not fooled by a patched getProject that invents the register entry', () => {
    const fx = productFixture();
    const forgedId = 'project-forged';
    const real = fx.ops.getProject.bind(fx.ops);
    const prototype = Object.getPrototypeOf(fx.ops) as {
      getProject: (id: string) => unknown;
      listProjects: () => unknown[];
    };
    prototype.getProject = (id: string) =>
      id === forgedId
        ? ({ id: forgedId, name: 'forged', purpose: 'forged', status: 'active' } as never)
        : (real(id) as never);
    prototype.listProjects = () => [
      { id: forgedId, name: 'forged', purpose: 'forged', status: 'active' } as never,
    ];
    try {
      // The lie TOOK on the public surface — otherwise this proves nothing.
      expect((fx.ops.getProject(forgedId) as { id: string } | null)?.id).toBe(forgedId);
      expect(fx.ops.listProjects().map((project) => project.id)).toEqual([forgedId]);
      // A facade constructed AFTER the patch inherits the same lie.
      const fresh = new HeadquarterOperations(fx.db, { store: new HeadquarterStore(fx.db) });
      expect((fresh.getProject(forgedId) as { id: string } | null)?.id).toBe(forgedId);

      const before = productCensus(fx);
      for (const ops of [fx.ops, fresh]) {
        const refused = ops.createProduct({
          projectId: forgedId,
          productType: 'web',
          name: 'Forged reference',
          problem: 'A problem',
          targetUsers: 'Users',
          requestedBy: 'founder',
        });
        expect(errorOf(refused).code).toBe('unknown_project');
      }
      expect(productCensus(fx)).toEqual(before);
    } finally {
      delete (prototype as { getProject?: unknown }).getProject;
      delete (prototype as { listProjects?: unknown }).listProjects;
    }
  });
});

describe('the Founder gate and the capability trio fail closed', () => {
  it('refuses a human who does not hold the product grant', () => {
    const fx = productFixture();
    const before = productCensus(fx);
    const refused = fx.ops.createProduct({
      projectId: fx.projectId,
      productType: 'web',
      name: 'Analyst product',
      problem: 'A problem',
      targetUsers: 'Users',
      requestedBy: 'analyst',
    });
    expect(errorOf(refused).code).toBe('not_permitted');
    expect(errorOf(refused).message).toContain(PRODUCT_COMMAND_CAPABILITY.id);
    expect(productCensus(fx)).toEqual(before);
  });

  it('refuses a registered WORKER, because this is a Founder act', () => {
    const fx = productFixture();
    const refused = fx.ops.createProduct({
      projectId: fx.projectId,
      productType: 'web',
      name: 'Worker product',
      problem: 'A problem',
      targetUsers: 'Users',
      requestedBy: 'claude',
    });
    expect(errorOf(refused).code).toBe('not_permitted');
    expect(errorOf(refused).message).toContain('Founder act');
  });

  it('refuses every write when the capability is unregistered, and never registers it', () => {
    const fx = productFixture({ registerProduct: false });
    const refused = fx.ops.createProduct({
      projectId: fx.projectId,
      productType: 'web',
      name: 'Ungated',
      problem: 'A problem',
      targetUsers: 'Users',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('unknown_capability');
    expect(errorOf(refused).message).toContain('separate, deliberate configuration action');
    expect(rows(fx, 'hq_products')).toBe(0);
    // Detecting the absence never repairs it: registration stays a separate act.
    const row = fx.db
      .prepare(`SELECT id FROM op_capabilities WHERE id = ?`)
      .get(PRODUCT_COMMAND_CAPABILITY.id);
    expect(row).toBeUndefined();
  });

  it('refuses when the capability IS registered but the Founder holds no grant', () => {
    // The other half of the same fail-closed pair: registration is not a
    // grant, and a grant is not a registration.
    const fx = productFixture({ grantProduct: false });
    const refused = fx.ops.createProduct({
      projectId: fx.projectId,
      productType: 'web',
      name: 'Ungranted',
      problem: 'A problem',
      targetUsers: 'Users',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('not_permitted');
    expect(rows(fx, 'hq_products')).toBe(0);
  });

  it('refuses a DISABLED capability without re-enabling it', () => {
    const fx = productFixture();
    fx.db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`).run(PRODUCT_COMMAND_CAPABILITY.id);
    const refused = fx.ops.moveProductLifecycle({
      productId: fx.productId,
      to: 'research',
      note: 'Should not land.',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('capability_disabled');
    expect(fx.ops.getProduct(fx.productId)!.lifecycle).toBe('idea');
    const still = fx.db
      .prepare(`SELECT enabled FROM op_capabilities WHERE id = ?`)
      .get(PRODUCT_COMMAND_CAPABILITY.id) as { enabled: number };
    expect(still.enabled).toBe(0);
  });

  it('refuses a capability whose reserved contract has drifted', () => {
    const fx = productFixture();
    fx.db
      .prepare(`UPDATE op_capabilities SET risk_class = 'read_only' WHERE id = ?`)
      .run(PRODUCT_COMMAND_CAPABILITY.id);
    const refused = fx.ops.registerProductArtifact({
      productId: fx.productId,
      kind: 'test_report',
      name: 'suite',
      locator: 'reports/suite.json',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('not_permitted');
    expect(errorOf(refused).message).toContain('drift');
  });
});

describe('artifact versions are immutable at the ENGINE, not by discipline', () => {
  it('appends a new row per version and never edits one', () => {
    const fx = productFixture();
    const second = expectOk(
      fx.ops.registerProductArtifact({
        productId: fx.productId,
        kind: 'specification',
        name: 'iridium console spec',
        locator: 'docs/iridium-console-spec.md',
        contentDigest: 'b'.repeat(64),
        requestedBy: 'founder',
      }),
    );
    expect(second.version).toBe(2);
    expect(second.artifactId).not.toBe(fx.specArtifactId);
    const versions = fx.db
      .prepare(`SELECT version, locator FROM hq_product_artifacts WHERE product_id = ? ORDER BY version`)
      .all(fx.productId) as { version: number; locator: string }[];
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    // Version 1 is still exactly what it was.
    const first = fx.db
      .prepare(`SELECT content_digest FROM hq_product_artifacts WHERE id = ?`)
      .get(fx.specArtifactId) as { content_digest: string };
    expect(first.content_digest).toBe('a'.repeat(64));
  });

  it('refuses UPDATE, DELETE, REPLACE and UPSERT on every Phase 12 table', () => {
    const fx = productFixture();
    const artifactId = fx.specArtifactId;

    expect(() =>
      fx.db.prepare(`UPDATE hq_product_artifacts SET locator = 'forged' WHERE id = ?`).run(artifactId),
    ).toThrow(/append-only/);
    expect(() => fx.db.prepare(`DELETE FROM hq_product_artifacts WHERE id = ?`).run(artifactId)).toThrow(
      /append-only/,
    );
    // REPLACE colliding on the id, and on the (product, kind, name, version)
    // unique index — the second is the one that IS the immutability of a
    // version, and a BEFORE DELETE trigger alone would never have fired for it.
    expect(() =>
      fx.db
        .prepare(
          `INSERT OR REPLACE INTO hq_product_artifacts
             (id, product_id, kind, name, version, locator, digest_provenance, record_digest,
              recorded_by, recorded_at, idempotency_key)
           VALUES (?, ?, 'specification', 'iridium console spec', 1, 'forged', 'not_provided', 'x',
                   'attacker', '2026-09-09T00:00:00.000Z', 'forged-key')`,
        )
        .run(artifactId, fx.productId),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db
        .prepare(
          `INSERT OR REPLACE INTO hq_product_artifacts
             (id, product_id, kind, name, version, locator, digest_provenance, record_digest,
              recorded_by, recorded_at, idempotency_key)
           VALUES ('artifact-other', ?, 'specification', 'iridium console spec', 1, 'forged',
                   'not_provided', 'x', 'attacker', '2026-09-09T00:00:00.000Z', 'forged-key-2')`,
        )
        .run(fx.productId),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db
        .prepare(
          `INSERT INTO hq_product_artifacts
             (id, product_id, kind, name, version, locator, digest_provenance, record_digest,
              recorded_by, recorded_at, idempotency_key)
           VALUES (?, ?, 'specification', 'iridium console spec', 1, 'forged', 'not_provided', 'x',
                   'attacker', '2026-09-09T00:00:00.000Z', 'forged-key-3')
           ON CONFLICT(id) DO UPDATE SET locator = 'forged'`,
        )
        .run(artifactId, fx.productId),
    ).toThrow(/append-only/);

    // The product row and its history are equally immutable.
    expect(() =>
      fx.db.prepare(`UPDATE hq_products SET name = 'forged' WHERE id = ?`).run(fx.productId),
    ).toThrow(/append-only/);
    expect(() => fx.db.prepare(`DELETE FROM hq_products WHERE id = ?`).run(fx.productId)).toThrow(
      /append-only/,
    );
    expect(() =>
      fx.db.prepare(`UPDATE hq_product_events SET to_state = 'released' WHERE product_id = ?`).run(fx.productId),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db.prepare(`DELETE FROM hq_product_events WHERE product_id = ?`).run(fx.productId),
    ).toThrow(/append-only/);

    // Nothing above changed anything.
    const after = fx.db
      .prepare(`SELECT locator, name FROM hq_product_artifacts WHERE id = ?`)
      .get(artifactId) as { locator: string; name: string };
    expect(after.locator).toBe('docs/iridium-console-spec.md');
    expect(fx.ops.getProduct(fx.productId)!.name).toBe('iridium console');
  });

  it('records the content digest as DECLARED, never verified, and rejects a non-digest', () => {
    const fx = productFixture();
    const declared = fx.ops.getProduct(fx.productId)!.artifacts[0]!;
    expect(declared.digestProvenance).toBe('declared_by_recorder');
    expect(declared.digestStatement).toContain('never verified the hash');

    const none = expectOk(
      fx.ops.registerProductArtifact({
        productId: fx.productId,
        kind: 'design_artifact',
        name: 'wireframes',
        locator: 'design/wireframes.fig',
        requestedBy: 'founder',
      }),
    );
    const undeclared = fx.ops
      .getProduct(fx.productId)!
      .artifacts.find((entry) => entry.id === none.artifactId)!;
    expect(undeclared.contentDigest).toBeNull();
    expect(undeclared.digestProvenance).toBe('not_provided');

    const refused = fx.ops.registerProductArtifact({
      productId: fx.productId,
      kind: 'build_artifact',
      name: 'bundle',
      locator: 'dist/bundle.tgz',
      contentDigest: 'not-a-digest',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('invalid_input');
    expect(errorOf(refused).message).toContain('never verifies it');
  });

  it('dedupes an identical version recording instead of minting a second one', () => {
    const fx = productFixture();
    const again = expectOk(
      fx.ops.registerProductArtifact({
        productId: fx.productId,
        kind: 'specification',
        name: 'iridium console spec',
        locator: 'docs/iridium-console-spec.md',
        contentDigest: 'a'.repeat(64),
        requestedBy: 'founder',
      }),
    );
    expect(again.deduplicated).toBe(true);
    expect(again.artifactId).toBe(fx.specArtifactId);
    expect(again.version).toBe(1);
    expect(rows(fx, 'hq_product_artifacts')).toBe(1);
  });
});

describe('the lifecycle is derived, and a patched read cannot buy an illegal move', () => {
  it('refuses a forward skip and states what is allowed', () => {
    const fx = productFixture();
    const refused = fx.ops.moveProductLifecycle({
      productId: fx.productId,
      to: 'released',
      note: 'Trying to skip.',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('invalid_product_lifecycle_move');
    expect(errorOf(refused).message).toContain('never skips forward');
    expect(fx.ops.getProduct(fx.productId)!.lifecycle).toBe('idea');
  });

  it('refuses every move without a note', () => {
    const fx = productFixture();
    const refused = fx.ops.moveProductLifecycle({
      productId: fx.productId,
      to: 'research',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('invalid_input');
    expect(errorOf(refused).message).toContain('requires a note');
  });

  it('honours the optimistic guard when the product moved underneath the caller', () => {
    const fx = productFixture();
    expectOk(
      fx.ops.moveProductLifecycle({
        productId: fx.productId,
        to: 'research',
        note: 'Moved by someone else first.',
        requestedBy: 'founder',
      }),
    );
    const refused = fx.ops.moveProductLifecycle({
      productId: fx.productId,
      to: 'research',
      note: 'Stale read.',
      expectedState: 'idea',
      requestedBy: 'founder',
    });
    expect(errorOf(refused).code).toBe('product_lifecycle_conflict');
  });

  it('is not fooled by a patched getProduct claiming the product is further along', () => {
    const fx = productFixture();
    const prototype = Object.getPrototypeOf(fx.ops) as { getProduct: (id: string) => unknown };
    const real = prototype.getProduct;
    prototype.getProduct = function patched(this: HeadquarterOperations, id: string) {
      const actual = real.call(this, id) as { lifecycle: string } | null;
      return actual ? { ...actual, lifecycle: 'review' } : null;
    };
    try {
      // The lie TOOK on the public surface.
      expect((fx.ops.getProduct(fx.productId) as { lifecycle: string }).lifecycle).toBe('review');
      const fresh = new HeadquarterOperations(fx.db, { store: new HeadquarterStore(fx.db) });
      expect((fresh.getProduct(fx.productId) as { lifecycle: string }).lifecycle).toBe('review');

      // And moved nothing: the real state is still `idea`, so the move that
      // would only be legal from `review` is refused, on both facades.
      for (const ops of [fx.ops, fresh]) {
        const refused = ops.moveProductLifecycle({
          productId: fx.productId,
          to: 'release_candidate',
          note: 'Riding the patched read.',
          requestedBy: 'founder',
        });
        expect(errorOf(refused).code).toBe('invalid_product_lifecycle_move');
      }
      // The one legal move from the REAL state still works.
      expectOk(
        fx.ops.moveProductLifecycle({
          productId: fx.productId,
          to: 'research',
          note: 'The real next step.',
          requestedBy: 'founder',
        }),
      );
    } finally {
      prototype.getProduct = real;
    }
    expect(fx.ops.getProduct(fx.productId)!.lifecycle).toBe('research');
  });

  it('keeps every superseded state in the ledger when a product regresses', () => {
    const fx = productFixture();
    advanceTo(fx, fx.productId, 'review');
    expectOk(
      fx.ops.moveProductLifecycle({
        productId: fx.productId,
        to: 'build',
        note: 'Review found a defect; back to build.',
        requestedBy: 'founder',
      }),
    );
    const product = fx.ops.getProduct(fx.productId)!;
    expect(product.lifecycle).toBe('build');
    // The LIFECYCLE half of the history; the artifact event carries no state
    // and is asserted separately, so this reads as the state trail it is.
    const states = product.history
      .filter((entry) => entry.kind !== 'artifact_versioned')
      .map((entry) => entry.toState);
    expect(states).toEqual([
      'idea',
      'research',
      'specification',
      'architecture',
      'build',
      'test',
      'review',
      'build',
    ]);
    expect(product.history.some((entry) => entry.kind === 'artifact_versioned')).toBe(true);
    expect(product.history.at(-1)!.note).toContain('Review found a defect');
  });
});

describe('reaching release_candidate and released performs NO external action', () => {
  it('writes one event row per move and touches no action table', () => {
    const fx = productFixture();
    const before = externalActionCensus(fx);
    const actionsBefore = rows(fx, 'hq_action_intents');
    advanceTo(fx, fx.productId, 'released');
    const product = fx.ops.getProduct(fx.productId)!;
    expect(product.lifecycle).toBe('released');
    // Eight moves plus the registration event plus one artifact event.
    expect(rows(fx, 'hq_product_events')).toBe(10);
    expect(externalActionCensus(fx)).toEqual(before);
    expect(rows(fx, 'hq_action_intents')).toBe(actionsBefore);
  });

  it('records in its own evidence entry that nothing external happened', () => {
    const fx = productFixture();
    expectOk(
      fx.ops.moveProductLifecycle({
        productId: fx.productId,
        to: 'research',
        note: 'Starting the research.',
        requestedBy: 'founder',
      }),
    );
    const entry = fx.db
      .prepare(
        `SELECT payload FROM op_evidence WHERE kind = 'product_lifecycle_moved' ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { payload: string } | undefined;
    expect(entry).toBeDefined();
    const payload = JSON.parse(entry!.payload) as Record<string, unknown>;
    expect(payload.externalActionTaken).toBe(false);
    expect(payload.executable).toBe(false);
    expect(payload.to).toBe('research');
  });

  it('exposes no facade method that could release, publish or deploy', () => {
    const fx = productFixture();
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(fx.ops) as object),
      ...Object.getOwnPropertyNames(fx.ops),
    ];
    const products = surface.filter((name) => /^product|Product/.test(name));
    // Exactly the seven product methods, and not one of them names an act
    // that reaches outside HQ.
    expect(products.sort()).toEqual([
      'createProduct',
      'getProduct',
      'listProducts',
      'listProductsBounded',
      'moveProductLifecycle',
      'productFactorySummary',
      'productPlanTemplate',
      'productReleaseReadiness',
      'productStorePresent',
      'registerProductArtifact',
    ]);
    for (const forbidden of ['releaseProduct', 'publishProduct', 'deployProduct', 'shipProduct']) {
      expect(surface).not.toContain(forbidden);
    }
  });
});

describe('a template creates nothing, and canonical creation still applies its own gate', () => {
  it('reads a plan without writing a single row', () => {
    const fx = productFixture();
    const before = productCensus(fx);
    const plan = expectOk(fx.ops.productPlanTemplate(fx.productId));
    expect(plan.missions.length).toBeGreaterThan(0);
    // Read it many times; the record does not move.
    for (let i = 0; i < 10; i += 1) expectOk(fx.ops.productPlanTemplate(fx.productId));
    expect(productCensus(fx)).toEqual(before);
  });

  it('refuses a template-derived mission from an actor without the MISSION grant', () => {
    const fx = productFixture();
    const plan = expectOk(fx.ops.productPlanTemplate(fx.productId));
    const first = plan.missions[0]!;
    const missionsBefore = rows(fx, 'hq_missions');
    // `codex` is a registered worker: a template line does not make it a
    // mission commander, and nothing about the plan changes that answer.
    const refused = fx.ops.commandMission({
      title: first.title,
      objective: first.objective,
      planItems: [...first.planItems],
      requestedBy: 'codex',
    });
    expect(errorOf(refused).code).toBe('not_permitted');
    expect(rows(fx, 'hq_missions')).toBe(missionsBefore);
  });

  it('creates a CANONICAL mission when the Founder commands one from the plan', () => {
    const fx = productFixture();
    const plan = expectOk(fx.ops.productPlanTemplate(fx.productId));
    const first = plan.missions[0]!;
    const mission = expectOk(
      fx.ops.commandMission({
        title: first.title,
        objective: first.objective,
        planItems: [...first.planItems],
        projectId: fx.projectId,
        requestedBy: 'founder',
      }),
    ).mission;
    // It landed in the CANONICAL mission table, on the canonical project —
    // not in a product-owned table, because none exists.
    const row = fx.db
      .prepare(`SELECT id, project_id FROM hq_missions WHERE id = ?`)
      .get(mission.id) as { id: string; project_id: string | null };
    expect(row.id).toBe(mission.id);
    expect(row.project_id).toBe(fx.projectId);
    // And no product table gained a task, a queue entry or a plan row.
    const productTables = fx.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hq_product%'`)
      .all() as { name: string }[];
    expect(productTables.map((entry) => entry.name).sort()).toEqual([
      'hq_product_artifacts',
      'hq_product_events',
      'hq_products',
    ]);
  });
});

describe('products and artifacts join the Phase 11 search registry', () => {
  it('finds a product by its problem statement and cites hq_products', () => {
    const fx = productFixture();
    const result = expectOk(fx.ops.searchCompany({ text: 'iridium' }, { includeFounderOnly: true }));
    const hit = result.hits.find((entry) => entry.document.source === 'product');
    expect(hit, 'the product must be findable').toBeDefined();
    expect(hit!.document.table).toBe('hq_products');
    expect(hit!.document.entityId).toBe(fx.productId);
    // The document's status is the DERIVED lifecycle, and its refs name the
    // canonical project the product references.
    expect(hit!.document.status).toBe('idea');
    expect(hit!.document.refs.map((ref) => ref.kind)).toContain('project');
  });

  it('finds an artifact version by its locator and cites hq_product_artifacts', () => {
    const fx = productFixture();
    const result = expectOk(
      fx.ops.searchCompany({ sources: ['artifact'], text: 'iridium' }, { includeFounderOnly: true }),
    );
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.document.source).toBe('artifact');
      expect(hit.document.table).toBe('hq_product_artifacts');
    }
    const versions = expectOk(
      fx.ops.searchCompany({ sources: ['artifact'] }, { includeFounderOnly: true }),
    );
    expect(versions.total).toBe(1);
  });

  it('answers a question about the product, grounded in the rows retrieved', () => {
    const fx = productFixture();
    const answer = expectOk(fx.ops.askJenify({ question: 'What is the iridium console?', includeFounderOnly: true }));
    expect(answer.state).toBe('grounded');
    expect(answer.citations.some((citation) => citation.document.source === 'product')).toBe(true);
    // The composed sentence is still counts and categorical states only.
    expect(answer.response).not.toContain('iridium');
  });

  it('leaves the founder_only isolation the registry already had exactly as it was', () => {
    const fx = productFixture();
    // A guarded reader sees no private string anywhere, and the withheld
    // count is unchanged by the two new (unclassified) sources.
    const guarded = expectOk(fx.ops.searchCompany({ text: 'obsidianfact' }, { includeFounderOnly: false }));
    expect(guarded.total).toBe(0);
    expect(leaksPrivateString(guarded)).toBeNull();
    expect(guarded.withheldFounderOnly).toBe(3);
    const productSource = guarded.sources.find((source) => source.id === 'product')!;
    expect(productSource.storePresent).toBe(true);
    expect(productSource.readableDocuments).toBe(1);
  });

  it('writes nothing to answer a product search', () => {
    const fx = productFixture();
    const before = productCensus(fx);
    expectOk(fx.ops.searchCompany({ sources: ['product', 'artifact'] }, { includeFounderOnly: true }));
    expectOk(fx.ops.askJenify({ question: 'what products exist', includeFounderOnly: true }));
    expect(productCensus(fx)).toEqual(before);
  });
});

describe('idempotency is derived, and the client key is an input to it', () => {
  it('dedupes an identical registration and mints a fresh one under a new key', () => {
    const fx = productFixture();
    const input = {
      projectId: fx.projectId,
      productType: 'mobile' as const,
      name: 'rhenium app',
      problem: 'A stated problem',
      targetUsers: 'Stated users',
      requestedBy: 'founder',
    };
    const first = expectOk(fx.ops.createProduct(input));
    const again = expectOk(fx.ops.createProduct(input));
    expect(again.deduplicated).toBe(true);
    expect(again.product.id).toBe(first.product.id);
    const distinct = expectOk(fx.ops.createProduct({ ...input, idempotencyKey: 'second-attempt' }));
    expect(distinct.deduplicated).toBe(false);
    expect(distinct.product.id).not.toBe(first.product.id);
    expect(rows(fx, 'hq_products')).toBe(3);
  });
});
