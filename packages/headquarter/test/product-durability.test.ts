/**
 * Phase 12 durability: a real file closed and reopened, and a read-only handle
 * over a database that predates the Product Factory.
 *
 * Three things an in-memory suite cannot prove.
 *
 * First, the product record is a function of the ROWS and of nothing held in
 * process memory: reopen the file and the derived lifecycle, the artifact
 * versions and every digest come back byte-identical.
 *
 * Second, immutability survives the process. The engine triggers live in the
 * file's schema, so a brand-new connection — one that never ran the module's
 * DDL and holds none of its code — still refuses an UPDATE, a DELETE and a
 * REPLACE on a recorded artifact version.
 *
 * Third, absence is OBSERVED, never migrated: a read-only handle over a file
 * with no Phase 12 tables reports the store absent, answers empty rather than
 * claiming zero products, still answers the Phase 11 search from the stores it
 * does have, and is not written to.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHqDatabase, openHqDatabaseReadOnly } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { expectOk } from './application.fixture.js';
import {
  PROJECT_COMMAND_CAPABILITY,
  registerProjectCommandCapability,
} from '../src/application/project-command.js';
import {
  PRODUCT_COMMAND_CAPABILITY,
  artifactRecordDigest,
  registerProductCommandCapability,
} from '../src/application/product-command.js';

const FOUNDER = 'founder';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function openHq(path: string): { db: ReturnType<typeof openHqDatabase>; ops: HeadquarterOperations } {
  const db = openHqDatabase(path);
  const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
  return { db, ops };
}

function seed(path: string): { db: ReturnType<typeof openHqDatabase>; ops: HeadquarterOperations } {
  const hq = openHq(path);
  registerProjectCommandCapability(hq.db);
  registerProductCommandCapability(hq.db);
  new HumanPrincipalRegistry(hq.db).register({
    id: FOUNDER,
    displayName: 'Founder',
    originateCapabilities: [PROJECT_COMMAND_CAPABILITY.id, PRODUCT_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return hq;
}

describe('a product survives a real close and reopen', () => {
  it('derives the same lifecycle, versions and digests from the rows alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-product-'));
    const path = join(dir, 'headquarter.sqlite');

    const writer = seed(path);
    const project = expectOk(
      writer.ops.createProject({
        name: 'osmium platform',
        purpose: 'The osmium delivery platform',
        requestedBy: FOUNDER,
      }),
    ).project;
    const product = expectOk(
      writer.ops.createProduct({
        projectId: project.id,
        productType: 'firmware',
        name: 'osmium controller',
        problem: 'The controller cannot report its own state.',
        targetUsers: 'Field technicians',
        requestedBy: FOUNDER,
      }),
    ).product;
    for (const to of ['research', 'specification']) {
      expectOk(
        writer.ops.moveProductLifecycle({
          productId: product.id,
          to,
          note: `Advance to ${to}.`,
          requestedBy: FOUNDER,
        }),
      );
    }
    expectOk(
      writer.ops.registerProductArtifact({
        productId: product.id,
        kind: 'specification',
        name: 'osmium spec',
        locator: 'docs/osmium.md',
        contentDigest: 'd'.repeat(64),
        requestedBy: FOUNDER,
      }),
    );
    expectOk(
      writer.ops.registerProductArtifact({
        productId: product.id,
        kind: 'specification',
        name: 'osmium spec',
        locator: 'docs/osmium.md',
        contentDigest: 'e'.repeat(64),
        requestedBy: FOUNDER,
      }),
    );
    const before = writer.ops.getProduct(product.id)!;
    writer.db.close();

    const reader = openHq(path);
    const after = reader.ops.getProduct(product.id)!;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.lifecycle).toBe('specification');
    expect(after.artifacts.map((entry) => entry.version)).toEqual([1, 2]);
    expect(after.artifacts.filter((entry) => entry.latest)).toHaveLength(1);

    // Every stored record digest still recomputes from the row it covers.
    for (const artifact of after.artifacts) {
      expect(
        artifactRecordDigest({
          productId: after.id,
          kind: artifact.kind,
          name: artifact.name,
          version: artifact.version,
          locator: artifact.locator,
          contentDigest: artifact.contentDigest,
          digestProvenance: artifact.digestProvenance,
          note: artifact.note,
          recordedBy: artifact.recordedBy,
          recordedAt: artifact.recordedAt,
        }),
      ).toBe(artifact.recordDigest);
    }
    reader.db.close();
  });

  it('refuses a rewrite from a RAW connection that never ran the module code', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-product-raw-'));
    const path = join(dir, 'headquarter.sqlite');

    const writer = seed(path);
    const project = expectOk(
      writer.ops.createProject({ name: 'raw project', purpose: 'A purpose', requestedBy: FOUNDER }),
    ).project;
    const product = expectOk(
      writer.ops.createProduct({
        projectId: project.id,
        productType: 'web',
        name: 'raw product',
        problem: 'A problem',
        targetUsers: 'Users',
        requestedBy: FOUNDER,
      }),
    ).product;
    const artifact = expectOk(
      writer.ops.registerProductArtifact({
        productId: product.id,
        kind: 'build_artifact',
        name: 'bundle',
        locator: 'dist/bundle.tgz',
        requestedBy: FOUNDER,
      }),
    );
    writer.db.close();

    // A plain better-sqlite3 handle: no HQ code, no module DDL, no discipline
    // — only the triggers that live in the file.
    const raw = new Database(path);
    try {
      expect(() =>
        raw.prepare(`UPDATE hq_product_artifacts SET locator = 'forged' WHERE id = ?`).run(artifact.artifactId),
      ).toThrow(/append-only/);
      expect(() =>
        raw.prepare(`DELETE FROM hq_product_artifacts WHERE id = ?`).run(artifact.artifactId),
      ).toThrow(/append-only/);
      expect(() =>
        raw
          .prepare(
            `INSERT OR REPLACE INTO hq_product_artifacts
               (id, product_id, kind, name, version, locator, digest_provenance, record_digest,
                recorded_by, recorded_at, idempotency_key)
             VALUES ('a-forged', ?, 'build_artifact', 'bundle', 1, 'forged', 'not_provided', 'x',
                     'attacker', '2026-09-09T00:00:00.000Z', 'forged')`,
          )
          .run(product.id),
      ).toThrow(/append-only/);
      expect(() =>
        raw.prepare(`UPDATE hq_products SET project_id = 'project-forged' WHERE id = ?`).run(product.id),
      ).toThrow(/append-only/);
    } finally {
      raw.close();
    }

    const reader = openHq(path);
    const after = reader.ops.getProduct(product.id)!;
    expect(after.artifacts[0]!.locator).toBe('dist/bundle.tgz');
    expect(after.projectId).toBe(project.id);
    reader.db.close();
  });
});

describe('a pre-Phase-12 file is OBSERVED, never migrated', () => {
  it('reports the store absent, answers empty, still searches, and is not written to', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-product-absent-'));
    const path = join(dir, 'headquarter.sqlite');

    const writer = seed(path);
    expectOk(
      writer.ops.createProject({ name: 'legacy project', purpose: 'A purpose', requestedBy: FOUNDER }),
    );
    // Drop the Phase 12 schema to simulate a file that predates it.
    writer.db.exec(`
      DROP TABLE hq_product_artifacts;
      DROP TABLE hq_product_events;
      DROP TABLE hq_products;
    `);
    writer.db.close();

    const before = statSync(path);
    const db = openHqDatabaseReadOnly(path);
    const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });

    expect(ops.productStorePresent()).toBe(false);
    expect(ops.listProducts()).toEqual([]);
    expect(ops.listProductsBounded()).toEqual({ products: [], total: 0, truncated: false });
    expect(ops.getProduct('product-anything')).toBeNull();

    // The snapshot section states the ABSENCE rather than an empty store.
    const summary = ops.productFactorySummary();
    expect(summary.storePresent).toBe(false);
    expect(summary.products).toBe(0);
    expect(summary.artifacts).toBe(0);

    // Phase 11 still answers from the stores this handle DOES have, and
    // observes the two new sources as absent rather than empty.
    const index = ops.searchIndexSummary({ includeFounderOnly: false });
    const productSource = index.sources.find((source) => source.id === 'product')!;
    const artifactSource = index.sources.find((source) => source.id === 'artifact')!;
    expect(productSource.storePresent).toBe(false);
    expect(artifactSource.storePresent).toBe(false);
    expect(productSource.readableDocuments).toBe(0);
    const answer = expectOk(ops.askJenify({ question: 'legacy project purpose', includeFounderOnly: false }));
    expect(answer.limitations.map((limitation) => limitation.code)).toContain('stores_absent');

    // A refusal, not a migration: a write attempt on a read-only handle
    // neither creates the schema nor throws its way past the gate.
    const refused = ops.createProduct({
      projectId: 'project-anything',
      productType: 'web',
      name: 'Should not land',
      problem: 'A problem',
      targetUsers: 'Users',
      requestedBy: FOUNDER,
    });
    expect(refused.ok).toBe(false);

    db.close();
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // And the tables are genuinely still gone.
    const check = new Database(path, { readonly: true });
    const table = check
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_products'`)
      .get();
    check.close();
    expect(table).toBeUndefined();
  });
});
