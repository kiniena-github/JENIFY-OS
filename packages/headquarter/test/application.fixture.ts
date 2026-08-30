/**
 * Shared fixture for the HQ lane F application-layer tests.
 *
 * Not a test file (no `.test.` in the name), so vitest's default glob does not
 * pick it up.
 */

import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import type { NominationSourcePort, WorkerNomination } from '../src/application/ports.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';

/** Capability ids used across the lane F tests. */
export const CAPS = {
  /** read_only, no side effect — completes directly, no review gate. */
  readStatus: 'repo.read_status',
  /** external_side_effect, PRE-APPROVED by standing policy, idempotent. */
  openPr: 'github.open_pr',
  /** external_side_effect, NOT pre-approved → Founder approval required. */
  indexDoc: 'archive.index_document',
  /** destructive → always Founder-gated; NOT idempotent. */
  dropIndex: 'infra.drop_index',
} as const;

export interface Fixture {
  db: HqDatabase;
  ops: HeadquarterOperations;
  store: HeadquarterStore;
  principals: HumanPrincipalRegistry;
}

export function setupFixture(
  options: { nominationSources?: readonly NominationSourcePort[] } = {},
): Fixture {
  const db = openMemoryHqDatabase();
  const store = new HeadquarterStore(db);
  const ops = new HeadquarterOperations(db, {
    store,
    policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
    nominationSources: options.nominationSources,
  });

  new CapabilityRegistry(db).register({
    id: CAPS.readStatus,
    description: 'Read repo/CI status',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  new CapabilityRegistry(db).register({
    id: CAPS.openPr,
    description: 'Open a branch-isolated PR',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: true,
  });
  new CapabilityRegistry(db).register({
    id: CAPS.indexDoc,
    description: 'Index a document into the archive',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: false,
  });
  new CapabilityRegistry(db).register({
    id: CAPS.dropIndex,
    description: 'Drop a search index',
    riskClass: 'destructive',
    sideEffect: true,
    idempotent: false,
  });

  // Builder that may do everything it is granted.
  store.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, CAPS.dropIndex],
    active: true,
  });
  // Independent reviewer — deliberately NOT granted the side-effect caps.
  store.upsertSpecialist({
    id: 'codex',
    displayName: 'Codex',
    vendor: 'openai',
    role: 'reviewer_gatekeeper',
    allowedCapabilities: [CAPS.readStatus],
    active: true,
  });
  // A second builder, used for wrong-worker and assignment-intent cases.
  store.upsertSpecialist({
    id: 'jules',
    displayName: 'Jules',
    vendor: 'google',
    role: 'parallel_implementer',
    allowedCapabilities: [CAPS.readStatus, CAPS.openPr],
    active: true,
  });
  // Disabled/replaced worker.
  store.upsertSpecialist({
    id: 'retired-bot',
    displayName: 'Retired Bot',
    vendor: 'internal',
    role: 'specialist_tool',
    allowedCapabilities: [CAPS.readStatus, CAPS.openPr],
    active: false,
  });

  // Human principals — a deliberately separate registry from the worker
  // directory. Nobody is authorized until registered here.
  const principals = new HumanPrincipalRegistry(db);
  // The Founder: may decide approvals and the kill switch, and may ORIGINATE
  // work for the two read-only/reversible-ish capabilities. Note this is still
  // not an execution right, and (per the canonical self-approval rule) does not
  // let them approve a task they opened themselves.
  principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc],
    approvalAuthority: true,
    active: true,
  });
  // A second human with approval authority but no origination grant at all.
  principals.register({
    id: 'coo',
    displayName: 'Chief Operating Officer',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  // A human who may open work but may never decide an approval.
  principals.register({
    id: 'analyst',
    displayName: 'Operations Analyst',
    originateCapabilities: [CAPS.readStatus],
    approvalAuthority: false,
    active: true,
  });
  // A departed human — registered but inactive.
  principals.register({
    id: 'former-cto',
    displayName: 'Former CTO',
    originateCapabilities: [CAPS.readStatus],
    approvalAuthority: true,
    active: false,
  });

  return { db, ops, store, principals };
}

/** Unwrap an expected-successful result, failing loudly otherwise. */
export function expectOk<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/** A nomination source that will happily suggest anyone — including liars. */
export function fakeNominationSource(
  id: string,
  nominations: readonly WorkerNomination[],
): NominationSourcePort {
  return { id, nominate: () => nominations };
}
