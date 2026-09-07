/**
 * Shared fixture for the Phase 12 Product Factory suites.
 *
 * Not a test file (no `.test.` in the name), so vitest's default glob does not
 * pick it up. Builds on the Phase 11 search fixture — which already carries
 * the Founder, the grantless `analyst` human, four workers, one commanded
 * mission with a real canonical task and real evidence, the memory/truth/
 * collaboration trios and a corpus with distinctive founder_only strings —
 * and adds what a product suite needs:
 *
 *  - the project-command and product-command capabilities registered, and the
 *    Founder granted both (so a product can reference a REAL register entry);
 *  - one open canonical project (`projectId`) and one CLOSED one
 *    (`closedProjectId`), so "the reference must resolve" has both cases;
 *  - one registered product with a specification artifact already versioned.
 *
 * Every distinctive word here is unique to exactly one record, so "did this
 * string cross the boundary" stays decidable without reasoning about
 * tokenization — the Phase 11 fixture rule, carried forward.
 */

import { searchFixture, type SearchFixture } from './search-ask.fixture.js';
import { CAPS, expectOk } from './application.fixture.js';
import { MISSION_COMMAND_CAPABILITY } from '../src/application/mission-command.js';
import { MEMORY_COMMAND_CAPABILITY } from '../src/application/memory-command.js';
import { WORKFORCE_ASSIGN_CAPABILITY } from '../src/application/workforce-command.js';
import { TRUTH_RECORD_CAPABILITY, TRUTH_VERIFY_CAPABILITY } from '../src/application/truth-command.js';
import { COLLABORATION_COMMAND_CAPABILITY } from '../src/application/collaboration-command.js';
import { FOUNDER_BRIEF_CAPABILITY } from '../src/application/chief-of-staff.js';
import {
  PROJECT_COMMAND_CAPABILITY,
  registerProjectCommandCapability,
} from '../src/application/project-command.js';
import {
  PRODUCT_COMMAND_CAPABILITY,
  registerProductCommandCapability,
} from '../src/application/product-command.js';

export interface ProductFixture extends SearchFixture {
  /** An OPEN canonical project; its name contains `palladium`. */
  projectId: string;
  /** A CLOSED canonical project; its name contains `caesium`. */
  closedProjectId: string;
  /** A registered product on `projectId`; its name contains `iridium`. */
  productId: string;
  /** The specification artifact version 1 recorded against that product. */
  specArtifactId: string;
}

/**
 * `registerProduct: false` leaves `hq.product_command` unregistered so a suite
 * can prove the capability gate fails closed; `grantProduct: false` registers
 * the capability but withholds the Founder's originate grant, which is the
 * other half of the same fail-closed pair.
 */
export function productFixture(
  options: { registerProduct?: boolean; grantProduct?: boolean } = {},
): ProductFixture {
  const fx = searchFixture();
  registerProjectCommandCapability(fx.db);
  if (options.registerProduct !== false) registerProductCommandCapability(fx.db);

  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.indexDoc,
      MISSION_COMMAND_CAPABILITY.id,
      MEMORY_COMMAND_CAPABILITY.id,
      WORKFORCE_ASSIGN_CAPABILITY.id,
      TRUTH_RECORD_CAPABILITY.id,
      TRUTH_VERIFY_CAPABILITY.id,
      COLLABORATION_COMMAND_CAPABILITY.id,
      FOUNDER_BRIEF_CAPABILITY.id,
      PROJECT_COMMAND_CAPABILITY.id,
      ...(options.grantProduct === false ? [] : [PRODUCT_COMMAND_CAPABILITY.id]),
    ],
    approvalAuthority: true,
    active: true,
  });

  const project = expectOk(
    fx.ops.createProject({
      name: 'palladium platform',
      purpose: 'The palladium delivery platform for tenant work',
      requestedBy: 'founder',
    }),
  ).project;
  const closed = expectOk(
    fx.ops.createProject({
      name: 'caesium archive',
      purpose: 'The caesium archive programme',
      requestedBy: 'founder',
    }),
  ).project;
  expectOk(
    fx.ops.transitionProject({
      projectId: closed.id,
      to: 'closed',
      note: 'The caesium programme is finished.',
      requestedBy: 'founder',
    }),
  );

  const base: ProductFixture = {
    ...fx,
    projectId: project.id,
    closedProjectId: closed.id,
    productId: '',
    specArtifactId: '',
  };
  if (options.registerProduct === false || options.grantProduct === false) return base;

  const product = expectOk(
    fx.ops.createProduct({
      projectId: project.id,
      productType: 'web',
      name: 'iridium console',
      problem: 'Operators cannot see the iridium pipeline without opening three tools.',
      targetUsers: 'Operations staff running the iridium pipeline',
      requestedBy: 'founder',
    }),
  ).product;
  const artifact = expectOk(
    fx.ops.registerProductArtifact({
      productId: product.id,
      kind: 'specification',
      name: 'iridium console spec',
      locator: 'docs/iridium-console-spec.md',
      contentDigest: 'a'.repeat(64),
      requestedBy: 'founder',
    }),
  );

  return { ...base, productId: product.id, specArtifactId: artifact.artifactId };
}

/** Advance a product to a lifecycle state, one legal step at a time. */
export function advanceTo(fx: ProductFixture, productId: string, target: string): void {
  const order = [
    'idea',
    'research',
    'specification',
    'architecture',
    'build',
    'test',
    'review',
    'release_candidate',
    'released',
  ];
  const stop = order.indexOf(target);
  if (stop < 0) throw new Error(`fixture: unknown lifecycle state ${target}`);
  for (let step = 1; step <= stop; step += 1) {
    expectOk(
      fx.ops.moveProductLifecycle({
        productId,
        to: order[step]!,
        note: `Fixture advance to ${order[step]}.`,
        requestedBy: 'founder',
      }),
    );
  }
}

/**
 * Every canonical table a product write must not touch, plus both append-only
 * log watermarks — the Phase 11 census, extended with the Phase 8 ledger and
 * the Phase 12 tables so a "nothing external happened" proof is decidable.
 */
export function productCensus(fx: ProductFixture): Record<string, number> {
  const tables = [
    'hq_missions',
    'hq_projects',
    'op_tasks',
    'hq_products',
    'hq_product_events',
    'hq_product_artifacts',
    'hq_memory',
    'hq_truth_records',
    'hq_collab_sessions',
    'hq_action_intents',
    'hq_action_events',
    'hq_approvals',
    'hq_specialists',
    'hq_events',
    'op_evidence',
  ];
  const census: Record<string, number> = {};
  for (const table of tables) {
    census[table] = (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  census['hq_events.maxSeq'] =
    (fx.db.prepare(`SELECT MAX(seq) AS s FROM hq_events`).get() as { s: number | null }).s ?? 0;
  census['op_evidence.maxSeq'] =
    (fx.db.prepare(`SELECT MAX(seq) AS s FROM op_evidence`).get() as { s: number | null }).s ?? 0;
  return census;
}

/** The tables an EXTERNAL action would have to touch. Nothing in Phase 12 may. */
export function externalActionCensus(fx: ProductFixture): Record<string, number> {
  return {
    intents: (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_action_intents`).get() as { n: number }).n,
    events: (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_action_events`).get() as { n: number }).n,
  };
}
