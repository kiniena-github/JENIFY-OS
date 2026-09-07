/**
 * Truth + Evidence — the truth/evidence graph PROJECTION (Phase 7).
 *
 * HQ distinguishes what was CLAIMED, OBSERVED, VERIFIED and Founder-ACCEPTED
 * about a canonical entity, as first-class records that reference real
 * provenance. This module owns the vocabulary, the two capability trios, the
 * append-only schema, the idempotency/digest derivations, the PURE state
 * derivation core and the browser projections. The facade (`service.ts`)
 * owns every authority decision and every write.
 *
 * What this projection deliberately is NOT:
 * - not a second evidence store — `op_evidence` remains evidence truth. A
 *   truth record REFERENCES evidence ids; it never copies a body and never
 *   writes into the chain except through the facade's ordinary
 *   `truth_recorded` / `truth_verified` / `truth_accepted` entries;
 * - not a competing authority over missions, tasks, approvals or memory —
 *   nothing reads these tables to decide eligibility, approval, claiming,
 *   dispatch or a kill switch (test-pinned), and no truth state changes any
 *   canonical status;
 * - not a score — states are categorical only; there is no confidence
 *   number anywhere in this module, by design and by the wire guard;
 * - not self-upgrading — the derived state of a record is computed from
 *   OTHER actors' verification and acceptance records. A record can never
 *   verify itself, an actor can never verify what it recorded, and
 *   `accepted` exists only behind the canonical Founder gate.
 */

import { createHash } from 'node:crypto';
import { deepFreeze } from '../contracts/freeze.js';
import type { HqDatabase } from '../store/db.js';
import { CapabilityRegistry, type Capability } from '../operator/capabilities.js';
import { canonicalJson } from '../operator/approvals.js';
import type { MemoryPrivacy } from '../memory/schema.js';

// ---- vocabulary (categorical only) ----

/** The four truth states. Categorical; there is no number behind any of them. */
export const TRUTH_STATES = deepFreeze(['claimed', 'observed', 'verified', 'accepted'] as const);
export type TruthState = (typeof TRUTH_STATES)[number];

/** A record is BORN in one of these two; `verified`/`accepted` are only ever derived. */
export const TRUTH_BORN_STATES = deepFreeze(['claimed', 'observed'] as const);
export type TruthBornState = (typeof TRUTH_BORN_STATES)[number];

export function isTruthBornState(value: unknown): value is TruthBornState {
  return typeof value === 'string' && (TRUTH_BORN_STATES as readonly string[]).includes(value);
}

/** Canonical entities a truth record may be ABOUT. Each names a real row; existence is the facade's job. */
export const TRUTH_ENTITY_KINDS = deepFreeze(['mission', 'project', 'task', 'memory', 'worker', 'capability'] as const);
export type TruthEntityKind = (typeof TRUTH_ENTITY_KINDS)[number];

export function isTruthEntityKind(value: unknown): value is TruthEntityKind {
  return typeof value === 'string' && (TRUTH_ENTITY_KINDS as readonly string[]).includes(value);
}

/**
 * Relationship kinds. The first four are STATED by the recording actor at
 * birth (immutable facts of the record); `verified_by` and `accepted_by` are
 * written only by the verify/accept acts, atomically with their records.
 */
export const TRUTH_RELATION_KINDS = deepFreeze([
  'supports',
  'contradicts',
  'supersedes',
  'derived_from',
  'verified_by',
  'accepted_by',
] as const);
export type TruthRelationKind = (typeof TRUTH_RELATION_KINDS)[number];

export const VERIFICATION_METHODS = deepFreeze([
  'reproduced',
  'inspected_evidence',
  'cross_checked_sources',
  'tested',
  'reviewed',
] as const);
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export function isVerificationMethod(value: unknown): value is VerificationMethod {
  return typeof value === 'string' && (VERIFICATION_METHODS as readonly string[]).includes(value);
}

export const VERIFICATION_VERDICTS = deepFreeze(['confirmed', 'refuted', 'inconclusive'] as const);
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

export function isVerificationVerdict(value: unknown): value is VerificationVerdict {
  return typeof value === 'string' && (VERIFICATION_VERDICTS as readonly string[]).includes(value);
}

/** Lifecycle of a record as a projection: superseded history stays auditable, never erased. */
export type TruthLifecycle = 'current' | 'superseded';

/**
 * The CURRENT standing of a record's Founder acceptance — categorical, derived,
 * never stored. The acceptance row is immutable history (who, when, over
 * which digest and verification ids); whether it still STANDS is a fact of
 * the graph now. An acceptance stands only while every precondition the
 * acceptance required still holds: verification `confirmed` (≥1 confirmed
 * and 0 refuted), lifecycle `current`, no unresolved contradiction. The
 * first broken precondition, in that order, is what is named:
 *
 * - `none`                  — the record was never accepted;
 * - `standing`              — accepted and every precondition still holds;
 *                             the record's `state` is `accepted`;
 * - `verification_refuted`  — a later verification refuted the record, so the
 *                             confirming basis the digest covered no longer
 *                             stands unopposed;
 * - `superseded`            — the record was superseded (an explicit,
 *                             Founder-gated act); its lifecycle is history;
 * - `contested`             — an unresolved contradiction now touches it.
 *
 * Whenever the standing is not `standing`, `state` derives exactly what the
 * record would derive WITHOUT the acceptance — `verified` while the
 * verification basis is intact, else the born state — so a later refutation,
 * contest or supersession can never keep presenting stale `accepted` truth.
 * Refutation and supersession are irreversible acts, so those standings are
 * final; a contest resolves only by an explicit act (a refutation or a
 * supersession of the other side), and a contest resolved in the record's
 * favour restores `standing` by derivation alone — the basis never moved and
 * nothing is written to restore it.
 */
export const TRUTH_ACCEPTANCE_STANDINGS = deepFreeze(['none', 'standing', 'verification_refuted', 'superseded', 'contested'] as const);
export type TruthAcceptanceStanding = (typeof TRUTH_ACCEPTANCE_STANDINGS)[number];

/**
 * The tier of truth a record EVER established, read by the supersession gate:
 * `accepted` if it holds an acceptance, else `verified` if any verification
 * confirmed it, else null. HISTORY-based on purpose: a later refutation or
 * contest lowers the record's current `state`, never the authority needed to
 * displace it from "current" (`#assertApprovalAuthority` in the facade).
 */
export type EstablishedTruthTier = 'verified' | 'accepted' | null;

/** The categorical verification picture of one record. `contested` = confirmed AND refuted both exist. */
export type TruthVerificationSummary = 'none' | 'confirmed' | 'refuted' | 'contested' | 'inconclusive';

/**
 * How a contradiction stands. NEVER decided by recency: two current,
 * unrefuted records that contradict each other stay `unresolved` until an
 * explicit act (a supersession or a refuting verification) settles one side.
 */
export type ContradictionResolution =
  | 'unresolved'
  | 'resolved_by_supersession'
  | 'resolved_by_refutation'
  | 'both_withdrawn';

/**
 * Whether the SUBJECT moved since the record was made — staleness, stated
 * categorically and never used to pick a winner.
 */
export type SubjectDrift =
  | 'none'
  | 'subject_changed_since_record'
  | 'subject_superseded'
  | 'subject_missing'
  | 'not_evaluated';

// ---- capabilities: the two trios ----

export const TRUTH_RECORD_CAPABILITY = deepFreeze({
  id: 'hq.truth_record',
  description:
    'Truth record — records a claimed or observed statement about a canonical entity, ' +
    'referencing existing evidence. Writes the truth projection only; executes nothing and ' +
    'upgrades nothing.',
  riskClass: 'reversible',
  sideEffect: false,
  idempotent: true,
} as const);

export const TRUTH_VERIFY_CAPABILITY = deepFreeze({
  id: 'hq.truth_verify',
  description:
    'Truth verification — records an independent verification verdict over an existing truth ' +
    'record, with method, evidence and limitations. Never verifies its own author’s records.',
  riskClass: 'reversible',
  sideEffect: false,
  idempotent: true,
} as const);

/** Register the truth-record capability — a CONFIGURATION action. */
export function registerTruthRecordCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...TRUTH_RECORD_CAPABILITY });
}

/** Register the truth-verify capability — a CONFIGURATION action. */
export function registerTruthVerifyCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...TRUTH_VERIFY_CAPABILITY });
}

type ReservedContract = { riskClass: string; sideEffect: boolean; idempotent: boolean };

function contractDrift(capability: Capability, reserved: ReservedContract): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== reserved.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== reserved.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== reserved.idempotent) drift.push('idempotent');
  return drift;
}

export function truthRecordContractDrift(capability: Capability): string[] {
  return contractDrift(capability, TRUTH_RECORD_CAPABILITY);
}

export function truthVerifyContractDrift(capability: Capability): string[] {
  return contractDrift(capability, TRUTH_VERIFY_CAPABILITY);
}

export type TruthCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/** Classify the registry row — enforcement-safe read, drift before enabled, never repairs. */
export function truthRecordCapabilityState(capability: Capability | null): TruthCapabilityState {
  if (!capability) return 'missing';
  if (truthRecordContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

export function truthVerifyCapabilityState(capability: Capability | null): TruthCapabilityState {
  if (!capability) return 'missing';
  if (truthVerifyContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

// ---- bounds ----

export const MAX_TRUTH_STATEMENT_LENGTH = 1000;
export const MAX_TRUTH_EVIDENCE_REFS = 20;
export const MAX_TRUTH_RELATION_REFS = 20;
export const MAX_TRUTH_ENTITY_ID_LENGTH = 200;
export const MAX_VERIFICATION_LIMITATIONS_LENGTH = 1000;
export const MAX_ACCEPTANCE_NOTE_LENGTH = 500;
/** Bounded reads: the true total is always stated beside a bounded list. */
export const TRUTH_READ_LIMIT = 50;
/** How many records the snapshot section carries (newest first). */
export const TRUTH_SNAPSHOT_LIMIT = 20;

// ---- idempotency and the acceptance digest ----

/**
 * Derived dedupe key for a truth record. The caller's `idempotencyKey` is an
 * INPUT to the digest, never the key itself (the mission/memory rule).
 */
export function truthRecordIdempotencyKey(input: {
  requestedBy: string;
  entityKind: TruthEntityKind;
  entityId: string;
  statement: string;
  bornState: TruthBornState;
  evidenceRefs: string[];
  privacy: MemoryPrivacy;
  supersedes: string | null;
  supports: string[];
  contradicts: string[];
  derivedFrom: string[];
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `truth:${digest.slice(0, 32)}`;
}

export function truthVerificationIdempotencyKey(input: {
  verifiedBy: string;
  truthId: string;
  method: VerificationMethod;
  verdict: VerificationVerdict;
  evidenceRefs: string[];
  limitations: string;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `truth-verification:${digest.slice(0, 32)}`;
}

/**
 * What a Founder ACCEPTS, exactly. The approve-route rule applied to truth:
 * the console renders this digest, the Founder confirms, the digest travels
 * back, and an acceptance whose basis moved (a new refutation, a
 * supersession, a different confirming set) is refused before any row
 * exists. Covers the record's identity and statement plus the confirming
 * verification ids — the basis of the `verified` state being accepted.
 */
export function truthAcceptanceDigest(input: {
  truthId: string;
  entityKind: TruthEntityKind;
  entityId: string;
  statement: string;
  supersedes: string | null;
  confirmingVerificationIds: string[];
}): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        ...input,
        confirmingVerificationIds: [...input.confirmingVerificationIds].sort(),
      }),
    )
    .digest('hex');
  return `truth-accept:${digest.slice(0, 32)}`;
}

// ---- schema: four tables, all INSERT-only BY ENGINE ----

/**
 * The full §G trigger set on every table (the hq_project_events /
 * hq_orchestration_runs recipe): no UPDATE of any column, no DELETE, and a
 * BEFORE INSERT guard that closes the REPLACE / INSERT OR REPLACE / UPSERT
 * path SQLite's default-off `recursive_triggers` lets slip past a DELETE
 * trigger. Unlike hq_memory there is NO legitimate mutation at all here:
 * lifecycle (superseded) is DERIVED from the immutable `supersedes` pointer
 * on the successor, so the predecessor row never changes.
 */
const TRUTH_DDL = `
CREATE TABLE IF NOT EXISTS hq_truth_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  born_state TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  privacy TEXT NOT NULL DEFAULT 'internal',
  supersedes TEXT,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_truth_records_entity ON hq_truth_records(entity_kind, entity_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_truth_records_idem
  ON hq_truth_records(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- One successor per predecessor: a second "supersession" of the same record
-- is a CONTRADICTION with the first successor and must be recorded as one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_truth_records_supersedes
  ON hq_truth_records(supersedes) WHERE supersedes IS NOT NULL;

CREATE TABLE IF NOT EXISTS hq_truth_relations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  from_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_truth_relations_from ON hq_truth_relations(from_id, kind);
CREATE INDEX IF NOT EXISTS idx_hq_truth_relations_to ON hq_truth_relations(to_kind, to_id, kind);

CREATE TABLE IF NOT EXISTS hq_truth_verifications (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  truth_id TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  verdict TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  limitations TEXT NOT NULL,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_truth_verifications_truth ON hq_truth_verifications(truth_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_truth_verifications_idem
  ON hq_truth_verifications(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS hq_truth_acceptances (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  truth_id TEXT NOT NULL,
  accepted_by TEXT NOT NULL,
  at TEXT NOT NULL,
  digest TEXT NOT NULL,
  verification_ids TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_truth_acceptances_truth ON hq_truth_acceptances(truth_id, seq);
-- Exactly one acceptance per record: accepted means ONE explicit Founder
-- act, attributable to one principal. A second acceptor conflicts; the same
-- acceptor deduplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_truth_acceptances_once
  ON hq_truth_acceptances(truth_id);

CREATE TRIGGER IF NOT EXISTS trg_hq_truth_records_no_rewrite
BEFORE UPDATE ON hq_truth_records
BEGIN SELECT RAISE(ABORT, 'hq_truth_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_records_no_erase
BEFORE DELETE ON hq_truth_records
BEGIN SELECT RAISE(ABORT, 'hq_truth_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_records_no_replace
BEFORE INSERT ON hq_truth_records
WHEN EXISTS (SELECT 1 FROM hq_truth_records WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_truth_records WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_truth_records is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_truth_relations_no_rewrite
BEFORE UPDATE ON hq_truth_relations
BEGIN SELECT RAISE(ABORT, 'hq_truth_relations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_relations_no_erase
BEFORE DELETE ON hq_truth_relations
BEGIN SELECT RAISE(ABORT, 'hq_truth_relations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_relations_no_replace
BEFORE INSERT ON hq_truth_relations
WHEN EXISTS (SELECT 1 FROM hq_truth_relations WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_truth_relations WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_truth_relations is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_truth_verifications_no_rewrite
BEFORE UPDATE ON hq_truth_verifications
BEGIN SELECT RAISE(ABORT, 'hq_truth_verifications is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_verifications_no_erase
BEFORE DELETE ON hq_truth_verifications
BEGIN SELECT RAISE(ABORT, 'hq_truth_verifications is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_verifications_no_replace
BEFORE INSERT ON hq_truth_verifications
WHEN EXISTS (SELECT 1 FROM hq_truth_verifications WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_truth_verifications WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_truth_verifications is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_truth_acceptances_no_rewrite
BEFORE UPDATE ON hq_truth_acceptances
BEGIN SELECT RAISE(ABORT, 'hq_truth_acceptances is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_acceptances_no_erase
BEFORE DELETE ON hq_truth_acceptances
BEGIN SELECT RAISE(ABORT, 'hq_truth_acceptances is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_acceptances_no_replace
BEFORE INSERT ON hq_truth_acceptances
WHEN EXISTS (SELECT 1 FROM hq_truth_acceptances WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_truth_acceptances WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_truth_acceptances is append-only'); END;

-- REPLACE resolves a conflict on ANY unique index by deleting the standing
-- row, and BEFORE DELETE does not fire for that delete on a connection with
-- recursive_triggers off (the default, and connection-scoped — nothing here
-- binds a foreign writer). The guards above test only id/seq, so a REPLACE
-- colliding on a SECONDARY unique index (idempotency_key, supersedes, the
-- one-acceptance-per-record index) used to erase the standing row and land
-- the forgery. These guards close every remaining unique index on the four
-- tables; they are ADDITIVE (new names) so a file created before them gains
-- them on the next ensure. hq_truth_relations has no secondary unique index.
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_records_no_replace_unique
BEFORE INSERT ON hq_truth_records
WHEN (NEW.idempotency_key IS NOT NULL
      AND EXISTS (SELECT 1 FROM hq_truth_records WHERE idempotency_key = NEW.idempotency_key))
  OR (NEW.supersedes IS NOT NULL
      AND EXISTS (SELECT 1 FROM hq_truth_records WHERE supersedes = NEW.supersedes))
BEGIN SELECT RAISE(ABORT, 'hq_truth_records is append-only (unique idempotency_key / supersedes already held)'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_verifications_no_replace_unique
BEFORE INSERT ON hq_truth_verifications
WHEN NEW.idempotency_key IS NOT NULL
  AND EXISTS (SELECT 1 FROM hq_truth_verifications WHERE idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'hq_truth_verifications is append-only (unique idempotency_key already held)'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_truth_acceptances_no_replace_unique
BEFORE INSERT ON hq_truth_acceptances
WHEN EXISTS (SELECT 1 FROM hq_truth_acceptances WHERE truth_id = NEW.truth_id)
BEGIN SELECT RAISE(ABORT, 'hq_truth_acceptances is append-only (one acceptance per record already held)'); END;
`;

/** Idempotent; readonly-safe (the post-Phase-3 ensure*Schema pattern). */
export function ensureTruthSchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(TRUTH_DDL);
}

/** True when the truth tables exist in this file — observation, never migration. */
export function truthSchemaPresent(db: HqDatabase): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_truth_records'`)
      .get() !== undefined
  );
}

// ---- stored rows (what the facade reads; never exposed raw) ----

export interface TruthRecordRow {
  seq: number;
  id: string;
  entityKind: TruthEntityKind;
  entityId: string;
  statement: string;
  bornState: TruthBornState;
  recordedBy: string;
  recordedAt: string;
  evidenceRefs: string[];
  privacy: MemoryPrivacy;
  supersedes: string | null;
}

export interface TruthRelationRow {
  seq: number;
  id: string;
  fromId: string;
  kind: TruthRelationKind;
  toKind: 'truth' | 'verification' | 'acceptance';
  toId: string;
  recordedBy: string;
  recordedAt: string;
}

export interface TruthVerificationRow {
  seq: number;
  id: string;
  truthId: string;
  verifiedBy: string;
  at: string;
  method: VerificationMethod;
  verdict: VerificationVerdict;
  evidenceRefs: string[];
  limitations: string;
}

export interface TruthAcceptanceRow {
  seq: number;
  id: string;
  truthId: string;
  acceptedBy: string;
  at: string;
  digest: string;
  verificationIds: string[];
  note: string | null;
}

/** Everything the derivation needs, loaded once. HQ scale is small; the reads are bounded on the wire. */
export interface TruthGraph {
  records: TruthRecordRow[];
  relations: TruthRelationRow[];
  verifications: TruthVerificationRow[];
  acceptances: TruthAcceptanceRow[];
}

export function loadTruthGraph(db: HqDatabase): TruthGraph {
  const records = (db.prepare(`SELECT * FROM hq_truth_records ORDER BY seq`).all() as Record<string, unknown>[]).map(
    (r) => ({
      seq: r.seq as number,
      id: r.id as string,
      entityKind: r.entity_kind as TruthEntityKind,
      entityId: r.entity_id as string,
      statement: r.statement as string,
      bornState: r.born_state as TruthBornState,
      recordedBy: r.recorded_by as string,
      recordedAt: r.recorded_at as string,
      evidenceRefs: JSON.parse(r.evidence_refs as string) as string[],
      privacy: r.privacy as MemoryPrivacy,
      supersedes: (r.supersedes as string | null) ?? null,
    }),
  );
  const relations = (
    db.prepare(`SELECT * FROM hq_truth_relations ORDER BY seq`).all() as Record<string, unknown>[]
  ).map((r) => ({
    seq: r.seq as number,
    id: r.id as string,
    fromId: r.from_id as string,
    kind: r.kind as TruthRelationKind,
    toKind: r.to_kind as TruthRelationRow['toKind'],
    toId: r.to_id as string,
    recordedBy: r.recorded_by as string,
    recordedAt: r.recorded_at as string,
  }));
  const verifications = (
    db.prepare(`SELECT * FROM hq_truth_verifications ORDER BY seq`).all() as Record<string, unknown>[]
  ).map((r) => ({
    seq: r.seq as number,
    id: r.id as string,
    truthId: r.truth_id as string,
    verifiedBy: r.verified_by as string,
    at: r.at as string,
    method: r.method as VerificationMethod,
    verdict: r.verdict as VerificationVerdict,
    evidenceRefs: JSON.parse(r.evidence_refs as string) as string[],
    limitations: r.limitations as string,
  }));
  const acceptances = (
    db.prepare(`SELECT * FROM hq_truth_acceptances ORDER BY seq`).all() as Record<string, unknown>[]
  ).map((r) => ({
    seq: r.seq as number,
    id: r.id as string,
    truthId: r.truth_id as string,
    acceptedBy: r.accepted_by as string,
    at: r.at as string,
    digest: r.digest as string,
    verificationIds: JSON.parse(r.verification_ids as string) as string[],
    note: (r.note as string | null) ?? null,
  }));
  return { records, relations, verifications, acceptances };
}

// ---- the pure derivation core ----

export interface TruthVerificationView {
  id: string;
  truthId: string;
  verifiedBy: string;
  at: string;
  method: VerificationMethod;
  verdict: VerificationVerdict;
  evidenceRefs: string[];
  limitations: string;
}

export interface TruthAcceptanceView {
  id: string;
  truthId: string;
  acceptedBy: string;
  at: string;
  digest: string;
  verificationIds: string[];
  note: string | null;
}

export interface TruthContradictionView {
  /** The record on the other side. */
  withId: string;
  /** Who stated the contradiction: this record (`stated`) or the other one (`stated_by`). */
  direction: 'stated' | 'stated_by';
  resolution: ContradictionResolution;
}

/**
 * The ONE browser-safe projection of a truth record, shared by the control
 * routes and the snapshot so the two can never disagree. Absent by shape:
 * the stored idempotency keys. Every field is a categorical fact or a
 * reference; there is no number here that HQ did not count.
 */
export interface TruthRecordView {
  id: string;
  seq: number;
  entityKind: TruthEntityKind;
  entityId: string;
  statement: string;
  bornState: TruthBornState;
  /**
   * DERIVED from other actors' records — never stored, never self-asserted.
   * `accepted` only while the acceptance STANDS (`acceptanceStanding`); a
   * record whose acceptance was later refuted, contested or superseded
   * derives what it would without the acceptance.
   */
  state: TruthState;
  lifecycle: TruthLifecycle;
  verification: TruthVerificationSummary;
  /** True while at least one contradiction involving this record is unresolved. */
  contested: boolean;
  /**
   * Whether the acceptance in `acceptances` still stands NOW, and if not, the
   * first broken precondition. `none` for a record never accepted. The
   * acceptance row itself stays in `acceptances` whatever the standing.
   */
  acceptanceStanding: TruthAcceptanceStanding;
  recordedBy: string;
  recordedAt: string;
  /** `op_evidence` ids — references, never copies. */
  evidenceRefs: string[];
  privacy: MemoryPrivacy;
  supersedes: string | null;
  supersededBy: string | null;
  supports: string[];
  contradicts: string[];
  derivedFrom: string[];
  supportedBy: string[];
  contradictedBy: string[];
  derivations: string[];
  verifications: TruthVerificationView[];
  acceptances: TruthAcceptanceView[];
  contradictions: TruthContradictionView[];
  subjectDrift: SubjectDrift;
  /**
   * The digest a Founder must echo to accept this record — present ONLY
   * while the record is exactly `verified`, current and uncontested; null
   * otherwise, so the browser cannot even draw an acceptance for anything
   * else. A record whose acceptance no longer stands never gets one: by
   * derivation it is either refuted (born state), superseded (not current)
   * or contested — never acceptable, and never re-accepted by a shortcut.
   */
  acceptanceDigest: string | null;
}

/** A minimal standing of one record, for judging a contradiction with it. */
interface Standing {
  superseded: boolean;
  refuted: boolean;
}

function verificationSummary(rows: readonly TruthVerificationRow[]): TruthVerificationSummary {
  const confirmed = rows.filter((v) => v.verdict === 'confirmed').length;
  const refuted = rows.filter((v) => v.verdict === 'refuted').length;
  if (confirmed > 0 && refuted > 0) return 'contested';
  if (confirmed > 0) return 'confirmed';
  if (refuted > 0) return 'refuted';
  if (rows.length > 0) return 'inconclusive';
  return 'none';
}

function standingOf(id: string, graph: TruthGraph): Standing {
  const superseded = graph.records.some((r) => r.supersedes === id);
  const summary = verificationSummary(graph.verifications.filter((v) => v.truthId === id));
  return { superseded, refuted: summary === 'refuted' };
}

/**
 * Judge one contradiction from its two standings. Stated once so every
 * surface agrees, and deliberately blind to timestamps.
 */
export function judgeContradiction(a: Standing, b: Standing): ContradictionResolution {
  const aOut = a.superseded || a.refuted;
  const bOut = b.superseded || b.refuted;
  if (aOut && bOut) return 'both_withdrawn';
  if (!aOut && !bOut) return 'unresolved';
  const out = aOut ? a : b;
  return out.superseded ? 'resolved_by_supersession' : 'resolved_by_refutation';
}

/**
 * Derive one record's view from the graph. PURE: no I/O, no clock. The
 * facade calls this from a private, enforcement-safe read for the accept
 * decision, and from the public reads for display — same function, so the
 * displayed state and the enforced state cannot disagree, while patching a
 * public read changes nothing the private path computes.
 */
export function deriveTruthRecord(
  record: TruthRecordRow,
  graph: TruthGraph,
  subjectDrift: SubjectDrift,
): TruthRecordView {
  const verifications = graph.verifications.filter((v) => v.truthId === record.id);
  const acceptances = graph.acceptances.filter((a) => a.truthId === record.id);
  const successor = graph.records.find((r) => r.supersedes === record.id) ?? null;
  const summary = verificationSummary(verifications);
  const out = (kind: TruthRelationKind) =>
    graph.relations.filter((r) => r.fromId === record.id && r.kind === kind && r.toKind === 'truth').map((r) => r.toId);
  const inbound = (kind: TruthRelationKind) =>
    graph.relations.filter((r) => r.toKind === 'truth' && r.toId === record.id && r.kind === kind).map((r) => r.fromId);

  const mine = standingOf(record.id, graph);
  const contradictions: TruthContradictionView[] = [
    ...out('contradicts').map((withId) => ({
      withId,
      direction: 'stated' as const,
      resolution: judgeContradiction(mine, standingOf(withId, graph)),
    })),
    ...inbound('contradicts').map((withId) => ({
      withId,
      direction: 'stated_by' as const,
      resolution: judgeContradiction(mine, standingOf(withId, graph)),
    })),
  ];
  const contested = contradictions.some((c) => c.resolution === 'unresolved');
  const lifecycle: TruthLifecycle = successor ? 'superseded' : 'current';

  // The current-standing rule (see TruthAcceptanceStanding): the acceptance
  // row is immutable history; it STANDS only while every precondition the
  // acceptance required still holds, and `state` is `accepted` only then.
  // Otherwise the record derives exactly what it would without it. The
  // ladder below names the first broken precondition, basis first.
  const verificationBasisHolds = summary === 'confirmed';
  const acceptanceStanding: TruthAcceptanceStanding =
    acceptances.length === 0
      ? 'none'
      : !verificationBasisHolds
        ? 'verification_refuted'
        : lifecycle !== 'current'
          ? 'superseded'
          : contested
            ? 'contested'
            : 'standing';
  const state: TruthState =
    acceptanceStanding === 'standing' ? 'accepted' : verificationBasisHolds ? 'verified' : record.bornState;
  const confirmingIds = verifications.filter((v) => v.verdict === 'confirmed').map((v) => v.id);
  const acceptable = state === 'verified' && lifecycle === 'current' && !contested;

  return {
    id: record.id,
    seq: record.seq,
    entityKind: record.entityKind,
    entityId: record.entityId,
    statement: record.statement,
    bornState: record.bornState,
    state,
    lifecycle,
    verification: summary,
    contested,
    acceptanceStanding,
    recordedBy: record.recordedBy,
    recordedAt: record.recordedAt,
    evidenceRefs: [...record.evidenceRefs],
    privacy: record.privacy,
    supersedes: record.supersedes,
    supersededBy: successor?.id ?? null,
    supports: out('supports'),
    contradicts: out('contradicts'),
    derivedFrom: out('derived_from'),
    supportedBy: inbound('supports'),
    contradictedBy: inbound('contradicts'),
    derivations: inbound('derived_from'),
    verifications: verifications.map((v) => ({
      id: v.id,
      truthId: v.truthId,
      verifiedBy: v.verifiedBy,
      at: v.at,
      method: v.method,
      verdict: v.verdict,
      evidenceRefs: [...v.evidenceRefs],
      limitations: v.limitations,
    })),
    acceptances: acceptances.map((a) => ({
      id: a.id,
      truthId: a.truthId,
      acceptedBy: a.acceptedBy,
      at: a.at,
      digest: a.digest,
      verificationIds: [...a.verificationIds],
      note: a.note,
    })),
    contradictions,
    subjectDrift,
    acceptanceDigest: acceptable
      ? truthAcceptanceDigest({
          truthId: record.id,
          entityKind: record.entityKind,
          entityId: record.entityId,
          statement: record.statement,
          supersedes: record.supersedes,
          confirmingVerificationIds: confirmingIds,
        })
      : null,
  };
}

/**
 * What tier of truth this record EVER established — the input to the
 * supersession gate. Reads the immutable rows, not the derived `state`, so
 * that a record once verified or once accepted keeps taking the Founder gate
 * to displace after its current standing fell (a later refutation lowers the
 * state; it must never lower the authority needed to retire the record).
 * PURE: no I/O, no clock.
 */
export function establishedTruthTier(record: TruthRecordRow, graph: TruthGraph): EstablishedTruthTier {
  if (graph.acceptances.some((a) => a.truthId === record.id)) return 'accepted';
  if (graph.verifications.some((v) => v.truthId === record.id && v.verdict === 'confirmed')) return 'verified';
  return null;
}

// ---- bounded read shapes ----

export interface TruthContradictionPair {
  a: string;
  b: string;
  entityKind: TruthEntityKind;
  entityId: string;
  resolution: ContradictionResolution;
  statedBy: string;
  statedAt: string;
}

/** Every stated contradiction in the graph, one row per relation, judged. */
export function listContradictions(
  graph: TruthGraph,
  viewOf: (id: string) => TruthRecordView | null,
): TruthContradictionPair[] {
  const out: TruthContradictionPair[] = [];
  for (const relation of graph.relations) {
    if (relation.kind !== 'contradicts' || relation.toKind !== 'truth') continue;
    const a = viewOf(relation.fromId);
    if (!a) continue;
    const judged = a.contradictions.find((c) => c.withId === relation.toId && c.direction === 'stated');
    out.push({
      a: relation.fromId,
      b: relation.toId,
      entityKind: a.entityKind,
      entityId: a.entityId,
      resolution: judged?.resolution ?? 'unresolved',
      statedBy: relation.recordedBy,
      statedAt: relation.recordedAt,
    });
  }
  return out;
}

export interface EntityTruthView {
  entityKind: TruthEntityKind;
  entityId: string;
  /** Categorical headline: the state of the current, most-verified record, or `none`. */
  currentState: TruthState | 'none';
  current: TruthRecordView[];
  /** Full history, oldest first, bounded; `total` states the true count. */
  history: TruthRecordView[];
  total: number;
  truncated: boolean;
  unresolvedContradictions: TruthContradictionPair[];
  provenance: { mode: 'live'; source: string; asOf: string };
}

/**
 * The headline state for an entity from its CURRENT records: the strongest
 * state any current record holds — but never `accepted`/`verified` while
 * that record is contested (a contested record's state is shown on the
 * record; the headline does not launder it). `state` already carries the
 * acceptance standing (an acceptance that no longer stands is not
 * `accepted`), so a degraded acceptance never reaches the headline either.
 */
export function entityCurrentState(current: readonly TruthRecordView[]): TruthState | 'none' {
  const rank: Record<TruthState, number> = { claimed: 0, observed: 1, verified: 2, accepted: 3 };
  let best: TruthState | 'none' = 'none';
  for (const record of current) {
    const effective: TruthState = record.contested ? record.bornState : record.state;
    if (best === 'none' || rank[effective] > rank[best]) best = effective;
  }
  return best;
}

export interface TruthSnapshotView {
  /** Every record, founder_only included; `total - withheldFounderOnly` is the set the reader may see. */
  total: number;
  /**
   * Counted over the set the reader may see (every record past the Founder
   * gate; the non-founder_only records in the unauthenticated artifact), NOT
   * bounded by the carried `records` page. Sums to `total - withheldFounderOnly`.
   * Scoped that way since review round 2: aggregate categorical facts about
   * withheld rows are still facts about them. Counts the CURRENT derived
   * state: a record whose acceptance no longer stands is counted under the
   * state it derives now, never under `accepted`.
   */
  byState: Record<TruthState, number>;
  /** Unresolved pairs with BOTH sides in the set the reader may see — the count of what `contradictions` summarises. */
  unresolvedContradictions: number;
  /**
   * Verified, current and uncontested records in the set the reader may see —
   * exactly those the server issued an acceptance digest for — counted over
   * ALL of them, not the bounded `records` page (review round 2).
   */
  awaitingAcceptance: number;
  /** founder_only records counted in `total` but not carried by this artifact. */
  withheldFounderOnly: number;
  /**
   * founder_only counterparts dropped from the carried records' relations
   * (supports / contradicts / derived_from / supersession, either direction,
   * and the per-record `contradictions` entries): one per withheld counterpart
   * per carried record. 0 when the reader may see founder_only.
   */
  withheldFounderOnlyRelations: number;
  records: TruthRecordView[];
  contradictions: TruthContradictionPair[];
}

/**
 * Project a carried record for a reader who may NOT see founder_only records.
 *
 * Withholding the founder_only RECORDS is not enough: a public record's view
 * carries its relations by id (`contradictedBy`, `supportedBy`, `derivations`,
 * `supersededBy`, and the judged `contradictions` entries), so the artifact
 * still named the private record and stated that it unresolvedly disputes the
 * public one — the existence of an internal dispute, which is the substance
 * founder_only protects. Every id pointing at a founder_only record is dropped
 * and counted once per counterpart. The record's own categorical standing
 * (`contested`, `lifecycle`, `state`) is NOT rewritten: a contested public
 * statement stays contested rather than being laundered for the public view.
 * Pure; the input view is not mutated.
 */
export function withholdFounderOnlyRelations(
  view: TruthRecordView,
  isFounderOnly: (id: string) => boolean,
): { view: TruthRecordView; withheld: number } {
  const dropped = new Set<string>();
  const keep = (ids: readonly string[]): string[] =>
    ids.filter((id) => {
      if (!isFounderOnly(id)) return true;
      dropped.add(id);
      return false;
    });
  const keepOne = (id: string | null): string | null => {
    if (id === null || !isFounderOnly(id)) return id;
    dropped.add(id);
    return null;
  };
  const projected: TruthRecordView = {
    ...view,
    supersedes: keepOne(view.supersedes),
    supersededBy: keepOne(view.supersededBy),
    supports: keep(view.supports),
    contradicts: keep(view.contradicts),
    derivedFrom: keep(view.derivedFrom),
    supportedBy: keep(view.supportedBy),
    contradictedBy: keep(view.contradictedBy),
    derivations: keep(view.derivations),
    contradictions: view.contradictions.filter((c) => {
      if (!isFounderOnly(c.withId)) return true;
      dropped.add(c.withId);
      return false;
    }),
  };
  return { view: projected, withheld: dropped.size };
}
