/**
 * Phase 12 — the Product Factory.
 *
 * HQ becomes a safe creation machine for Jenify products WITHOUT becoming a
 * second task system and without acquiring a way to release anything. Five
 * laws, stated here because they are the phase boundary and every function
 * below is written to keep them:
 *
 * 1. **A product REFERENCES a canonical project; it never replaces one.** The
 *    Phase 4 register (`hq_projects`) stays the one answer to "what bodies of
 *    work does the company have". A product row carries product-domain
 *    metadata ONLY — type, the problem and who it is for, its artifact
 *    versions and its lifecycle — hanging off a `project_id` that must name a
 *    real, open register entry at the moment it is written. A product against
 *    a forged or absent project is refused, and nothing is written.
 *
 * 2. **The product lifecycle is NOT task truth.** `idea → research →
 *    specification → architecture → build → test → review →
 *    release_candidate → released` describes the PRODUCT. It is a different
 *    vocabulary from `ActivityStatus` on purpose (the two share no member),
 *    and NOTHING derives worker eligibility, claiming, dispatch, approval or
 *    kill-switch state from it. A product's lifecycle state is a statement
 *    about a thing being built, never a permission to build it.
 *
 * 3. **Real work runs on canonical missions and Operator tasks.** There is no
 *    product job queue here, no product-owned task table and no product
 *    dispatch. A template may RECOMMEND a mission structure; the
 *    recommendation is a value with no ids in it, and turning one into work
 *    means calling the same Founder-gated `commandMission` path everything
 *    else calls, with its own capability gate. A template grants nothing.
 *
 * 4. **Artifact history is immutable.** Every artifact version is a NEW ROW
 *    with the next version number for its (product, kind, name) line. The
 *    three tables here are INSERT-ONLY BY ENGINE — the full Phase 7/8 trigger
 *    set, including the BEFORE INSERT guards that close REPLACE and UPSERT —
 *    so an in-place edit is refused by SQLite itself and not merely by this
 *    module's discipline.
 *
 * 5. **`release_candidate` is a lifecycle state, not a deploy.** Moving a
 *    product to `release_candidate` or `released` is a record: it contacts
 *    nothing, publishes nothing and reaches no adapter. A real publish is an
 *    EXTERNAL ACTION and has exactly one path — the Phase 8 gateway, with its
 *    risk assessment, its bound approval, its Intent Guard and its kill
 *    switches. This module deliberately exposes no execution seam at all, so
 *    there is nothing here to bypass the gateway WITH.
 *
 * Digest honesty, stated once: HQ never fetches an artifact. A caller-supplied
 * `contentDigest` is recorded as `declared_by_recorder` and is never called
 * verified; the `recordDigest` this module computes covers the ROW's own
 * canonical fields and is the only digest HQ can stand behind.
 */

import { createHash } from 'node:crypto';
import { deepFreeze } from '../contracts/freeze.js';
import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { canonicalJson } from '../operator/approvals.js';
import { CapabilityRegistry, type Capability, type RiskClass } from '../operator/capabilities.js';

/* ------------------------------------------------------------------ */
/* Vocabulary (categorical only)                                       */
/* ------------------------------------------------------------------ */

/**
 * What kind of thing is being built. METADATA plus an extension point: the
 * type selects a plan template and nothing else. No specialty engine, no
 * per-type build pipeline and no per-type authority exists in this phase, and
 * a type never changes what a Founder gate decides.
 */
export const PRODUCT_TYPES = deepFreeze([
  'web',
  'mobile',
  'desktop',
  'backend_service',
  'ai_workflow',
  'media_technology',
  'hardware_iot_concept',
  'firmware',
] as const);
export type ProductType = (typeof PRODUCT_TYPES)[number];

export function isProductType(value: unknown): value is ProductType {
  return typeof value === 'string' && (PRODUCT_TYPES as readonly string[]).includes(value);
}

/**
 * The product lifecycle — a statement about the PRODUCT, in strict order.
 *
 * Deliberately disjoint from `ActivityStatus` (the canonical task vocabulary)
 * and from `MissionStatus`: no member is shared, so no code and no reader can
 * mistake one for the other, and a test pins that disjointness. Nothing in HQ
 * reads a value from this list to decide eligibility, claiming, dispatch,
 * approval, execution or a kill switch.
 */
export const PRODUCT_LIFECYCLE_STATES = deepFreeze([
  'idea',
  'research',
  'specification',
  'architecture',
  'build',
  'test',
  'review',
  'release_candidate',
  'released',
] as const);
export type ProductLifecycleState = (typeof PRODUCT_LIFECYCLE_STATES)[number];

export function isProductLifecycleState(value: unknown): value is ProductLifecycleState {
  return typeof value === 'string' && (PRODUCT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** Every product starts here, at registration, and the first event says so. */
export const PRODUCT_INITIAL_LIFECYCLE: ProductLifecycleState = 'idea';

export const PRODUCT_LIFECYCLE_STATEMENT =
  'This is the PRODUCT’s lifecycle, not a task status and not a worker state. Nothing in HQ derives ' +
  'eligibility, claiming, dispatch, approval, execution or a kill-switch decision from it, and no value ' +
  'here is a member of the canonical task vocabulary. Reaching release_candidate or released is a record ' +
  'about the product; it publishes nothing and authorizes nothing.';

/**
 * Forward exactly one step, or BACK to any earlier state.
 *
 * Forward-skipping is refused because a product that never had a
 * specification cannot honestly be `build`. Backward movement is allowed to
 * any earlier state because products genuinely regress — a review sends work
 * back to build, and a released product re-enters build for its next version
 * — and pretending otherwise would push people to record a false state.
 * Every move requires a note, so a regression always carries its reason.
 */
export function canMoveProductLifecycle(
  from: ProductLifecycleState,
  to: ProductLifecycleState,
): boolean {
  const at = PRODUCT_LIFECYCLE_STATES.indexOf(from);
  const next = PRODUCT_LIFECYCLE_STATES.indexOf(to);
  if (at < 0 || next < 0 || at === next) return false;
  return next === at + 1 || next < at;
}

/** The states reachable from `from`, stated so a refusal can list them. */
export function allowedProductLifecycleMoves(from: ProductLifecycleState): ProductLifecycleState[] {
  return PRODUCT_LIFECYCLE_STATES.filter((state) => canMoveProductLifecycle(from, state));
}

/**
 * What an artifact IS. Versioned, immutable, referenced by locator — HQ
 * records that an artifact exists and what it is called, never its bytes.
 */
export const PRODUCT_ARTIFACT_KINDS = deepFreeze([
  'source_package',
  'specification',
  'architecture_doc',
  'design_artifact',
  'test_report',
  'build_artifact',
  'firmware_artifact',
  'schema',
  'release_candidate',
] as const);
export type ProductArtifactKind = (typeof PRODUCT_ARTIFACT_KINDS)[number];

export function isProductArtifactKind(value: unknown): value is ProductArtifactKind {
  return typeof value === 'string' && (PRODUCT_ARTIFACT_KINDS as readonly string[]).includes(value);
}

/**
 * Where a content digest came from. There is deliberately no `verified`
 * member: HQ does not fetch the artifact, so it can never claim to have
 * checked one. A recorder's hash is recorded AS a recorder's hash.
 */
export const ARTIFACT_DIGEST_PROVENANCES = deepFreeze(['declared_by_recorder', 'not_provided'] as const);
export type ArtifactDigestProvenance = (typeof ARTIFACT_DIGEST_PROVENANCES)[number];

export const ARTIFACT_DIGEST_STATEMENT =
  'contentDigest is DECLARED by whoever recorded the version; HQ never fetched the artifact and never ' +
  'verified the hash, so it is never reported as verified. recordDigest is computed by HQ over this row’s ' +
  'own canonical fields and pins the row itself — the row is engine-immutable, so a changed recordDigest ' +
  'is impossible rather than merely detectable.';

/** Product event kinds — the append-only history of one product. */
export const PRODUCT_EVENT_KINDS = deepFreeze(['registered', 'lifecycle_moved', 'artifact_versioned'] as const);
export type ProductEventKind = (typeof PRODUCT_EVENT_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Capability (the CONFIGURATION vs INVOCATION trio)                   */
/* ------------------------------------------------------------------ */

/**
 * The one capability every Product Factory write exercises.
 *
 * NOT registered automatically anywhere: a deployment that wants the Product
 * Factory calls `registerProductCommandCapability` explicitly, as a
 * CONFIGURATION action, and until then every write fails closed.
 *
 * `sideEffect: false` is honest — registering a product, moving its lifecycle
 * and versioning an artifact all write canonical control-plane rows and reach
 * nothing outside HQ. The risk class is `founder_gate` because declaring what
 * the company is building is a Founder act.
 */
export const PRODUCT_COMMAND_CAPABILITY = deepFreeze({
  id: 'hq.product_command',
  description:
    'Founder product command — registers products against canonical projects, moves the product ' +
    'lifecycle and versions artifacts. Records what is being built; executes, publishes and deploys nothing.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const);

/** Register the product-command capability — a CONFIGURATION action. */
export function registerProductCommandCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...PRODUCT_COMMAND_CAPABILITY });
}

/** The definition fields that carry the Founder gate. */
export const PRODUCT_COMMAND_RESERVED_CONTRACT = deepFreeze({
  riskClass: PRODUCT_COMMAND_CAPABILITY.riskClass,
  sideEffect: PRODUCT_COMMAND_CAPABILITY.sideEffect,
  idempotent: PRODUCT_COMMAND_CAPABILITY.idempotent,
} as const);

/** Which contract fields the registry's CURRENT row disagrees with, if any. */
export function productCommandContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== PRODUCT_COMMAND_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== PRODUCT_COMMAND_RESERVED_CONTRACT.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== PRODUCT_COMMAND_RESERVED_CONTRACT.idempotent) drift.push('idempotent');
  return drift;
}

export type ProductCommandCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/**
 * Classify the registry's current row. Callers supply the row from an
 * ENFORCEMENT-SAFE read, never from `queue.capabilities` (#219). Drift is
 * checked before `enabled`, and detecting drift never repairs it.
 */
export function productCommandCapabilityState(
  capability: Capability | null,
): ProductCommandCapabilityState {
  if (!capability) return 'missing';
  if (productCommandContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

export const MAX_PRODUCT_NAME_LENGTH = 120;
export const MAX_PRODUCT_PROBLEM_LENGTH = 500;
export const MAX_PRODUCT_TARGET_USERS_LENGTH = 300;
export const MAX_PRODUCT_SUMMARY_LENGTH = 1000;
export const MAX_PRODUCT_NOTE_LENGTH = 500;
export const MAX_ARTIFACT_NAME_LENGTH = 120;
export const MAX_ARTIFACT_LOCATOR_LENGTH = 500;
/** Bounded reads: the true total is always stated beside a bounded list. */
export const PRODUCT_READ_LIMIT = 50;
/** Artifact versions carried on one product view; the true total is stated. */
export const PRODUCT_ARTIFACT_READ_LIMIT = 100;
/** Products carried in the unauthenticated snapshot section: none (counts only). */
export const PRODUCT_SNAPSHOT_LIMIT = 0;

/** A sha256 hex digest, and nothing else, when a content digest is supplied. */
export const CONTENT_DIGEST_PATTERN = deepFreeze(/^[a-f0-9]{64}$/);

/* ------------------------------------------------------------------ */
/* Schema — three tables, all INSERT-only BY ENGINE                    */
/* ------------------------------------------------------------------ */

/**
 * The full §G trigger set on all three tables (the `hq_truth_*` / Phase 8
 * recipe): no UPDATE of any column, no DELETE, a BEFORE INSERT guard on
 * `id`/`seq` that closes REPLACE and UPSERT, and a second BEFORE INSERT guard
 * on every SECONDARY unique index — because REPLACE colliding on a unique
 * index deletes the standing row without any BEFORE DELETE firing
 * (recursive_triggers is off by default and connection-scoped).
 *
 * On `hq_product_artifacts` that second guard is the one that matters most:
 * the unique `(product_id, kind, name, version)` index IS the immutability of
 * an artifact version, and a REPLACE landing on it would silently retire a
 * recorded version and put a different locator and digest at the same version
 * number — history rewritten, with nothing to show it happened.
 */
const PRODUCT_DDL = `
CREATE TABLE IF NOT EXISTS hq_products (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  product_type TEXT NOT NULL,
  name TEXT NOT NULL,
  problem TEXT NOT NULL,
  target_users TEXT NOT NULL,
  summary TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_products_project ON hq_products(project_id, seq);

CREATE TABLE IF NOT EXISTS hq_product_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  note TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_product_events_product ON hq_product_events(product_id, seq);

CREATE TABLE IF NOT EXISTS hq_product_artifacts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  locator TEXT NOT NULL,
  content_digest TEXT,
  digest_provenance TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  note TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_product_artifacts_product ON hq_product_artifacts(product_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_product_artifacts_version
  ON hq_product_artifacts(product_id, kind, name, version);

CREATE TRIGGER IF NOT EXISTS trg_hq_products_no_rewrite
BEFORE UPDATE ON hq_products
BEGIN SELECT RAISE(ABORT, 'hq_products is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_products_no_erase
BEFORE DELETE ON hq_products
BEGIN SELECT RAISE(ABORT, 'hq_products is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_products_no_replace
BEFORE INSERT ON hq_products
WHEN EXISTS (SELECT 1 FROM hq_products WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_products WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_products is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_products_no_replace_unique
BEFORE INSERT ON hq_products
WHEN EXISTS (SELECT 1 FROM hq_products WHERE idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'hq_products is append-only (unique idempotency_key already held)'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_product_events_no_rewrite
BEFORE UPDATE ON hq_product_events
BEGIN SELECT RAISE(ABORT, 'hq_product_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_product_events_no_erase
BEFORE DELETE ON hq_product_events
BEGIN SELECT RAISE(ABORT, 'hq_product_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_product_events_no_replace
BEFORE INSERT ON hq_product_events
WHEN EXISTS (SELECT 1 FROM hq_product_events WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_product_events WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_product_events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_product_artifacts_no_rewrite
BEFORE UPDATE ON hq_product_artifacts
BEGIN SELECT RAISE(ABORT, 'hq_product_artifacts is append-only — a new version is a new row'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_product_artifacts_no_erase
BEFORE DELETE ON hq_product_artifacts
BEGIN SELECT RAISE(ABORT, 'hq_product_artifacts is append-only — a version is never deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_product_artifacts_no_replace
BEFORE INSERT ON hq_product_artifacts
WHEN EXISTS (SELECT 1 FROM hq_product_artifacts WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_product_artifacts WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_product_artifacts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_product_artifacts_no_replace_version
BEFORE INSERT ON hq_product_artifacts
WHEN EXISTS (
  SELECT 1 FROM hq_product_artifacts
  WHERE product_id = NEW.product_id AND kind = NEW.kind AND name = NEW.name AND version = NEW.version
)
BEGIN SELECT RAISE(ABORT, 'hq_product_artifacts is append-only (that artifact version is already recorded)'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_product_artifacts_no_replace_unique
BEFORE INSERT ON hq_product_artifacts
WHEN EXISTS (SELECT 1 FROM hq_product_artifacts WHERE idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'hq_product_artifacts is append-only (unique idempotency_key already held)'); END;
`;

/**
 * Idempotent; safe to call on every construction of the service.
 *
 * Never attempts DDL on a READ-ONLY handle: `hq:snapshot` legitimately builds
 * the service over `openHqDatabaseReadOnly`, and a pre-Phase-12 file must be
 * OBSERVED truthfully (`productFactorySchemaPresent`), never migrated by a
 * path that promised to write nothing.
 */
export function ensureProductFactorySchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(PRODUCT_DDL);
}

/** True when this file carries the Phase 12 schema — observation, never migration. */
export function productFactorySchemaPresent(db: HqDatabase): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_products'`).get() !==
    undefined
  );
}

/* ------------------------------------------------------------------ */
/* Digests and keys                                                    */
/* ------------------------------------------------------------------ */

/**
 * Derived dedupe key for a product registration. The caller's
 * `idempotencyKey` is an INPUT to the digest, never the key itself (the
 * mission/project/memory/truth rule), so an identical registration dedupes
 * and a deliberate fresh one is possible.
 */
export function productIdempotencyKey(input: {
  requestedBy: string;
  projectId: string;
  productType: ProductType;
  name: string;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `product:${digest.slice(0, 32)}`;
}

/**
 * Derived dedupe key for one artifact VERSION.
 *
 * The version number is deliberately NOT an input: the caller never states a
 * version (the ledger derives it), and two identical recordings of the same
 * artifact line and locator are the same act. A genuinely new version of the
 * same file — a rebuild with the same locator — is distinguished by its
 * content digest or by an explicit client key.
 */
export function artifactIdempotencyKey(input: {
  requestedBy: string;
  productId: string;
  kind: ProductArtifactKind;
  name: string;
  locator: string;
  contentDigest: string | null;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `artifact:${digest.slice(0, 32)}`;
}

/** The fields a `recordDigest` covers. Exported so a reader can recompute it. */
export interface ArtifactDigestInputs {
  productId: string;
  kind: ProductArtifactKind;
  name: string;
  version: number;
  locator: string;
  contentDigest: string | null;
  digestProvenance: ArtifactDigestProvenance;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}

/**
 * The digest HQ can stand behind: sha256 over the row's own canonical fields.
 *
 * It is not a hash of the artifact's bytes and never claims to be. What it
 * pins is the RECORD — and because the table is engine-immutable, a row whose
 * fields disagree with its stored digest cannot be produced through any path
 * this repository has, which is what the durability suite checks.
 */
export function artifactRecordDigest(inputs: ArtifactDigestInputs): string {
  return createHash('sha256').update(canonicalJson({ ...inputs })).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Stored rows                                                         */
/* ------------------------------------------------------------------ */

export interface ProductRow {
  seq: number;
  id: string;
  projectId: string;
  productType: ProductType;
  name: string;
  problem: string;
  targetUsers: string;
  summary: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ProductEventRow {
  seq: number;
  id: string;
  productId: string;
  at: string;
  actor: string;
  kind: ProductEventKind;
  fromState: ProductLifecycleState | null;
  toState: ProductLifecycleState | null;
  note: string | null;
  detail: Record<string, unknown> | null;
}

export interface ProductArtifactRow {
  seq: number;
  id: string;
  productId: string;
  kind: ProductArtifactKind;
  name: string;
  version: number;
  locator: string;
  contentDigest: string | null;
  digestProvenance: ArtifactDigestProvenance;
  recordDigest: string;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}

function rowToProduct(r: Record<string, unknown>): ProductRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    projectId: r.project_id as string,
    productType: r.product_type as ProductType,
    name: r.name as string,
    problem: r.problem as string,
    targetUsers: r.target_users as string,
    summary: (r.summary as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
  };
}

/**
 * A stored state column becomes a lifecycle state only if it IS one.
 *
 * `hq_product_events` is append-only, and an append is the one write the
 * triggers deliberately permit — so a row can exist whose `to_state` is free
 * text that no facade path would ever have written. Casting that column to
 * `ProductLifecycleState` made the type a runtime lie, and the lie travelled:
 * into `deriveProductRecord`'s `lifecycle`, into the search corpus as a
 * product document's `status`, and — as an OBJECT KEY — into the
 * unauthenticated snapshot. Anything that is not a vocabulary member is
 * therefore read as `null`: not a move, because HQ will not invent a member
 * for a value it does not recognise, and cannot honestly report one either.
 */
function stateColumn(value: unknown): ProductLifecycleState | null {
  return isProductLifecycleState(value) ? value : null;
}

function rowToProductEvent(r: Record<string, unknown>): ProductEventRow {
  let detail: Record<string, unknown> | null = null;
  if (typeof r.detail === 'string') {
    try {
      const parsed: unknown = JSON.parse(r.detail);
      detail = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
  }
  return {
    seq: r.seq as number,
    id: r.id as string,
    productId: r.product_id as string,
    at: r.at as string,
    actor: r.actor as string,
    kind: r.kind as ProductEventKind,
    fromState: stateColumn(r.from_state),
    toState: stateColumn(r.to_state),
    note: (r.note as string | null) ?? null,
    detail,
  };
}

function rowToArtifact(r: Record<string, unknown>): ProductArtifactRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    productId: r.product_id as string,
    kind: r.kind as ProductArtifactKind,
    name: r.name as string,
    version: r.version as number,
    locator: r.locator as string,
    contentDigest: (r.content_digest as string | null) ?? null,
    digestProvenance: r.digest_provenance as ArtifactDigestProvenance,
    recordDigest: r.record_digest as string,
    note: (r.note as string | null) ?? null,
    recordedBy: r.recorded_by as string,
    recordedAt: r.recorded_at as string,
  };
}

export function loadProduct(db: HqDatabase, id: string): ProductRow | null {
  const row = db.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToProduct(row) : null;
}

export function loadProducts(db: HqDatabase): ProductRow[] {
  return (db.prepare(`SELECT * FROM hq_products ORDER BY seq`).all() as Record<string, unknown>[]).map(
    rowToProduct,
  );
}

export function loadProductEvents(db: HqDatabase, productId: string): ProductEventRow[] {
  return (
    db.prepare(`SELECT * FROM hq_product_events WHERE product_id = ? ORDER BY seq`).all(productId) as Record<
      string,
      unknown
    >[]
  ).map(rowToProductEvent);
}

export function loadProductArtifacts(db: HqDatabase, productId: string): ProductArtifactRow[] {
  return (
    db
      .prepare(`SELECT * FROM hq_product_artifacts WHERE product_id = ? ORDER BY kind, name, version`)
      .all(productId) as Record<string, unknown>[]
  ).map(rowToArtifact);
}

export function loadAllProductArtifacts(db: HqDatabase): ProductArtifactRow[] {
  return (
    db.prepare(`SELECT * FROM hq_product_artifacts ORDER BY seq`).all() as Record<string, unknown>[]
  ).map(rowToArtifact);
}

/** The next version number for one artifact line. Read inside the write transaction. */
export function nextArtifactVersion(
  db: HqDatabase,
  input: { productId: string; kind: ProductArtifactKind; name: string },
): number {
  const row = db
    .prepare(
      `SELECT MAX(version) AS v FROM hq_product_artifacts
       WHERE product_id = ? AND kind = ? AND name = ?`,
    )
    .get(input.productId, input.kind, input.name) as { v: number | null };
  return (row.v ?? 0) + 1;
}

export function findProductIdByIdempotencyKey(db: HqDatabase, key: string): string | null {
  const row = db.prepare(`SELECT id FROM hq_products WHERE idempotency_key = ?`).get(key) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

export function findArtifactIdByIdempotencyKey(db: HqDatabase, key: string): string | null {
  const row = db.prepare(`SELECT id FROM hq_product_artifacts WHERE idempotency_key = ?`).get(key) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Writes (called by the service INSIDE its transaction)               */
/* ------------------------------------------------------------------ */

/** Append one product history event. INSERT-only by design and by trigger. */
export function appendProductEvent(
  db: HqDatabase,
  input: {
    productId: string;
    actor: string;
    kind: ProductEventKind;
    fromState?: ProductLifecycleState | null;
    toState?: ProductLifecycleState | null;
    note?: string | null;
    detail?: Record<string, unknown> | null;
  },
): void {
  db.prepare(
    `INSERT INTO hq_product_events (id, product_id, at, actor, kind, from_state, to_state, note, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    input.productId,
    nowIso(),
    input.actor,
    input.kind,
    input.fromState ?? null,
    input.toState ?? null,
    input.note ?? null,
    input.detail ? JSON.stringify(input.detail) : null,
  );
}

/* ------------------------------------------------------------------ */
/* The pure derivation core                                            */
/* ------------------------------------------------------------------ */

export interface ProductEventView {
  seq: number;
  id: string;
  at: string;
  actor: string;
  kind: ProductEventKind;
  fromState: ProductLifecycleState | null;
  toState: ProductLifecycleState | null;
  note: string | null;
}

export interface ProductArtifactView {
  id: string;
  kind: ProductArtifactKind;
  name: string;
  version: number;
  locator: string;
  contentDigest: string | null;
  digestProvenance: ArtifactDigestProvenance;
  recordDigest: string;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
  /** True for the highest recorded version of this (kind, name) line. */
  latest: boolean;
  /** Stated on every artifact, so a declared hash is never read as a verified one. */
  digestStatement: string;
}

/**
 * Server-derived authority truth for the product-command act itself — the
 * `ProjectAuthorityTruth` shape and reasoning: unknown stated as null, never
 * invented, and never an echo of a classification.
 */
export interface ProductAuthorityTruth {
  riskClass: RiskClass | null;
  founderOnly: true;
  approvalFlow: 'originate_gated_no_approval_row';
  /** Stated on every product: nothing here can execute or publish. */
  executesExternally: false;
}

export interface ProductRecord {
  id: string;
  /** The canonical `hq_projects` row this product hangs off. A reference, never a copy. */
  projectId: string;
  productType: ProductType;
  name: string;
  problem: string;
  targetUsers: string;
  summary: string | null;
  createdBy: string;
  createdAt: string;
  /** DERIVED from the append-only event ledger — never a stored mutable column. */
  lifecycle: ProductLifecycleState;
  lifecycleChangedAt: string | null;
  lifecycleChangedBy: string | null;
  lifecycleStatement: string;
  authority: ProductAuthorityTruth;
  artifacts: ProductArtifactView[];
  /** True total of artifact versions; `artifacts` may be a bounded page. */
  artifactTotal: number;
  history: ProductEventView[];
}

/**
 * The ONE browser-safe projection of a product, shared by the control routes
 * and every facade read so the two can never disagree. Nothing is absent by
 * shape here — the product record carries no payload, no secret and no
 * classification — but the projection exists so a future field is an explicit
 * decision rather than an accidental disclosure.
 */
export type ProductBrowserView = ProductRecord;

export function productBrowserView(product: ProductRecord): ProductBrowserView {
  return product;
}

/**
 * Derive one product's whole record from its immutable rows. PURE: no I/O and
 * no clock.
 *
 * The lifecycle is the `toState` of the LAST event that carries one, which is
 * the registration event (`idea`) until a move happens. There is deliberately
 * no lifecycle column to disagree with the ledger.
 *
 * `lifecycle: ProductLifecycleState` is a claim about a value derived from
 * stored rows, so it is CHECKED here rather than asserted. `rowToProductEvent`
 * already reads a non-vocabulary state column as `null`; this second guard
 * covers a caller that builds `events` itself, and keeps the promise true for
 * every construction of the record. An event carrying an unrecognised state is
 * not a move: the record falls back to the last state HQ genuinely recognises,
 * which leaves `canMoveProductLifecycle` a real member to reason from rather
 * than a string it must refuse forever.
 */
export function deriveProductRecord(input: {
  row: ProductRow;
  events: readonly ProductEventRow[];
  artifacts: readonly ProductArtifactRow[];
  capability: Capability | null;
  artifactLimit?: number;
}): ProductRecord {
  const moves = input.events.filter((event) => isProductLifecycleState(event.toState));
  const last = moves[moves.length - 1] ?? null;
  const lifecycle =
    last !== null && isProductLifecycleState(last.toState) ? last.toState : PRODUCT_INITIAL_LIFECYCLE;
  const lifecycleMoves = input.events.filter((event) => event.kind === 'lifecycle_moved');
  const lastMove = lifecycleMoves[lifecycleMoves.length - 1] ?? null;

  const latestOf = new Map<string, number>();
  for (const artifact of input.artifacts) {
    // U+001F UNIT SEPARATOR, not a raw NUL: a literal 0x00 makes this file
    // binary to grep/git grep/ripgrep, which then skip its content entirely.
    // Same runtime value; the file stays greppable (Wave 5 Medium 10).
    const line = `${artifact.kind}${artifact.name}`;
    latestOf.set(line, Math.max(latestOf.get(line) ?? 0, artifact.version));
  }
  const limit = Math.min(
    Math.max(input.artifactLimit ?? PRODUCT_ARTIFACT_READ_LIMIT, 1),
    PRODUCT_ARTIFACT_READ_LIMIT,
  );
  const artifacts = input.artifacts.slice(0, limit).map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    version: artifact.version,
    locator: artifact.locator,
    contentDigest: artifact.contentDigest,
    digestProvenance: artifact.digestProvenance,
    recordDigest: artifact.recordDigest,
    note: artifact.note,
    recordedBy: artifact.recordedBy,
    recordedAt: artifact.recordedAt,
    latest: latestOf.get(`${artifact.kind}${artifact.name}`) === artifact.version,
    digestStatement: ARTIFACT_DIGEST_STATEMENT,
  }));

  return {
    id: input.row.id,
    projectId: input.row.projectId,
    productType: input.row.productType,
    name: input.row.name,
    problem: input.row.problem,
    targetUsers: input.row.targetUsers,
    summary: input.row.summary,
    createdBy: input.row.createdBy,
    createdAt: input.row.createdAt,
    lifecycle,
    lifecycleChangedAt: lastMove?.at ?? null,
    lifecycleChangedBy: lastMove?.actor ?? null,
    lifecycleStatement: PRODUCT_LIFECYCLE_STATEMENT,
    authority: {
      riskClass: input.capability ? input.capability.riskClass : null,
      founderOnly: true,
      approvalFlow: 'originate_gated_no_approval_row',
      executesExternally: false,
    },
    artifacts,
    artifactTotal: input.artifacts.length,
    history: input.events.map((event) => ({
      seq: event.seq,
      id: event.id,
      at: event.at,
      actor: event.actor,
      kind: event.kind,
      fromState: event.fromState,
      toState: event.toState,
      note: event.note,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Plan templates — RECOMMENDATIONS, never authority                   */
/* ------------------------------------------------------------------ */

/**
 * The one statement every recommendation carries, verbatim.
 *
 * A template is text. It creates nothing, holds no id, reserves nothing and
 * grants nothing; turning any line of it into work means calling the ordinary
 * Founder-gated mission path, which will apply its own actor resolution and
 * its own capability gate exactly as it does for a mission nobody templated.
 */
export const TEMPLATE_AUTHORITY_STATEMENT =
  'This is a RECOMMENDATION, not a plan HQ has adopted and not an authorization. Nothing here exists as a ' +
  'row: no mission, no task, no approval, no claim and no capability was created, reserved or granted by ' +
  'reading it. Each line becomes real work only by commanding a canonical mission through ' +
  'hq.mission_command — the same Founder-gated path any other mission takes, with the same actor ' +
  'resolution, the same capability gate and the same audit. A template can never widen what its reader ' +
  'may already do.';

export interface ProductPlanTemplateMission {
  title: string;
  objective: string;
  planItems: readonly string[];
}

export interface ProductPlanTemplate {
  id: string;
  productType: ProductType;
  /** What this template is for, and what it deliberately does not cover. */
  statement: string;
  missions: readonly ProductPlanTemplateMission[];
}

/**
 * One template per product type. Deliberately SHALLOW: each is the small set
 * of missions that is true of building that kind of thing at all, and no
 * template pretends to specialist knowledge this phase did not build (a
 * firmware template that invented a toolchain, a certification step or a
 * compliance gate would be exactly the fabricated business rule the
 * repository rules forbid).
 */
export const PRODUCT_PLAN_TEMPLATES: readonly ProductPlanTemplate[] = deepFreeze([
  {
    id: 'template.web.v1',
    productType: 'web',
    statement:
      'A web product: understand the user and the problem, specify it, decide the architecture, build it, ' +
      'test it and review it. Hosting, domains and release are deliberately absent — a release is an ' +
      'external action through the Phase 8 gateway, never a plan item.',
    missions: [
      {
        title: 'Research the problem and the user',
        objective: 'Establish who this is for and what problem it solves, from evidence rather than assumption.',
        planItems: ['Record what is already known', 'Record what is still unknown'],
      },
      {
        title: 'Write the specification',
        objective: 'State what the product does and does not do, in enough detail to build from.',
        planItems: ['Draft the specification', 'Register it as a specification artifact version'],
      },
      {
        title: 'Decide and record the architecture',
        objective: 'Choose the structure and record why, so the decision can be revisited with its reasons.',
        planItems: ['Draft the architecture document', 'Register it as an architecture_doc artifact version'],
      },
      {
        title: 'Build the product',
        objective: 'Implement what the specification states.',
        planItems: ['Implement', 'Register the source package artifact version'],
      },
      {
        title: 'Test and review',
        objective: 'Establish what works and what does not, and record the result as evidence.',
        planItems: ['Run the tests', 'Register the test report artifact version'],
      },
    ],
  },
  {
    id: 'template.mobile.v1',
    productType: 'mobile',
    statement:
      'A mobile product. Store submission, signing and distribution are deliberately absent: each is an ' +
      'external action through the Phase 8 gateway with its own Founder gate.',
    missions: [
      {
        title: 'Research the problem and the user',
        objective: 'Establish who this is for and what problem it solves, from evidence rather than assumption.',
        planItems: ['Record what is already known', 'Record what is still unknown'],
      },
      {
        title: 'Write the specification',
        objective: 'State what the product does and does not do, including the platforms it targets.',
        planItems: ['Draft the specification', 'Register it as a specification artifact version'],
      },
      {
        title: 'Build the product',
        objective: 'Implement what the specification states.',
        planItems: ['Implement', 'Register the source package artifact version'],
      },
      {
        title: 'Test on real devices',
        objective: 'Establish what works on the targeted platforms, and record the result as evidence.',
        planItems: ['Run the tests', 'Register the test report artifact version'],
      },
    ],
  },
  {
    id: 'template.desktop.v1',
    productType: 'desktop',
    statement:
      'A desktop product. Installer signing and distribution are deliberately absent: both are external ' +
      'actions through the Phase 8 gateway.',
    missions: [
      {
        title: 'Write the specification',
        objective: 'State what the product does and does not do, and which platforms it supports.',
        planItems: ['Draft the specification', 'Register it as a specification artifact version'],
      },
      {
        title: 'Build the product',
        objective: 'Implement what the specification states.',
        planItems: ['Implement', 'Register the build artifact version'],
      },
      {
        title: 'Test and review',
        objective: 'Establish what works on each supported platform and record the result as evidence.',
        planItems: ['Run the tests', 'Register the test report artifact version'],
      },
    ],
  },
  {
    id: 'template.backend_service.v1',
    productType: 'backend_service',
    statement:
      'A backend service. Provisioning, deployment and production data are deliberately absent: each is a ' +
      'Founder-gated external action, and two of them are irreversible.',
    missions: [
      {
        title: 'Specify the service contract',
        objective: 'State the interface, the data it owns and the guarantees it makes.',
        planItems: ['Draft the specification', 'Register the schema artifact version'],
      },
      {
        title: 'Decide and record the architecture',
        objective: 'Choose the structure and record why.',
        planItems: ['Draft the architecture document', 'Register it as an architecture_doc artifact version'],
      },
      {
        title: 'Build the service',
        objective: 'Implement the specified contract.',
        planItems: ['Implement', 'Register the source package artifact version'],
      },
      {
        title: 'Test and review',
        objective: 'Establish what the service does under test, and record the result as evidence.',
        planItems: ['Run the tests', 'Register the test report artifact version'],
      },
    ],
  },
  {
    id: 'template.ai_workflow.v1',
    productType: 'ai_workflow',
    statement:
      'An AI workflow or automation. Model selection, paid inference and any autonomous action are ' +
      'deliberately absent: enabling a paid model is a Founder spend gate, and an automation that acts ' +
      'externally does so through the Phase 8 gateway like everything else.',
    missions: [
      {
        title: 'State the intent and the boundary',
        objective: 'State what the workflow decides, what it must never decide, and how a human stays in it.',
        planItems: ['Draft the specification', 'Register it as a specification artifact version'],
      },
      {
        title: 'Build the workflow',
        objective: 'Implement the stated intent within the stated boundary.',
        planItems: ['Implement', 'Register the source package artifact version'],
      },
      {
        title: 'Test the boundary, not only the happy path',
        objective: 'Establish what the workflow does when it is wrong, and record the result as evidence.',
        planItems: ['Run the tests', 'Register the test report artifact version'],
      },
    ],
  },
  {
    id: 'template.media_technology.v1',
    productType: 'media_technology',
    statement:
      'A media-technology product. Rights, licensing and publication are deliberately absent: none is a ' +
      'technical step, and publication is an external action through the Phase 8 gateway.',
    missions: [
      {
        title: 'Specify the media pipeline',
        objective: 'State the inputs, the outputs and the quality the pipeline must hold.',
        planItems: ['Draft the specification', 'Register it as a specification artifact version'],
      },
      {
        title: 'Build the pipeline',
        objective: 'Implement what the specification states.',
        planItems: ['Implement', 'Register the source package artifact version'],
      },
      {
        title: 'Test the output quality',
        objective: 'Establish what the pipeline produces, and record the result as evidence.',
        planItems: ['Run the tests', 'Register the test report artifact version'],
      },
    ],
  },
  {
    id: 'template.hardware_iot_concept.v1',
    productType: 'hardware_iot_concept',
    statement:
      'A hardware or IoT CONCEPT — the concept, not the manufacture. Sourcing, tooling, certification and ' +
      'manufacture are deliberately absent: HQ holds no supplier, standards or compliance knowledge, and ' +
      'inventing a certification step would be inventing a business rule.',
    missions: [
      {
        title: 'State the concept and its constraints',
        objective: 'State what the device does, and the physical and power constraints it must live inside.',
        planItems: ['Draft the specification', 'Register it as a specification artifact version'],
      },
      {
        title: 'Record the architecture concept',
        objective: 'Record the intended structure and the open questions it still carries.',
        planItems: ['Draft the architecture document', 'Register it as an architecture_doc artifact version'],
      },
    ],
  },
  {
    id: 'template.firmware.v1',
    productType: 'firmware',
    statement:
      'Firmware. Flashing a device, signing an image and any over-the-air update are deliberately absent: ' +
      'each reaches the physical world and is therefore an external action through the Phase 8 gateway.',
    missions: [
      {
        title: 'Specify the firmware behaviour',
        objective: 'State what the firmware does, on which hardware, and what it must never do.',
        planItems: ['Draft the specification', 'Register it as a specification artifact version'],
      },
      {
        title: 'Build the image',
        objective: 'Implement the specified behaviour.',
        planItems: ['Implement', 'Register the firmware artifact version'],
      },
      {
        title: 'Test on the target hardware',
        objective: 'Establish what the image does on the real device, and record the result as evidence.',
        planItems: ['Run the tests', 'Register the test report artifact version'],
      },
    ],
  },
]);

/**
 * The template for a product type, or `null` when there is none.
 *
 * Takes `string` and answers `null` rather than taking `ProductType` and
 * throwing. PRODUCT_TYPES and the template list are pinned equal, so every
 * genuine member resolves — but `hq_products.product_type` is a stored column,
 * and a row carrying free text made the declared `ProductType` a runtime lie
 * that surfaced as an uncaught throw and a 500. A value outside the closed
 * vocabulary has no template, which is a fact this function can state; its
 * caller turns that into a typed refusal.
 */
export function productPlanTemplateFor(productType: string): ProductPlanTemplate | null {
  return PRODUCT_PLAN_TEMPLATES.find((template) => template.productType === productType) ?? null;
}

/**
 * A recommendation about a REAL registered product.
 *
 * Note the shape: there is no mission id, no task id, no plan-item id and no
 * handle of any kind. There is nothing here to "accept", which is the point —
 * a recommendation a route could accept would be an authorization with an
 * innocent name (the Phase 10 rule about recommendations, applied to plans).
 */
export interface ProductPlanRecommendationView {
  productId: string;
  productType: ProductType;
  templateId: string;
  templateStatement: string;
  missions: ProductPlanTemplateMission[];
  /** Always false. A template never grants executable authority. */
  grantsAuthority: false;
  /** Always true. Reading a recommendation writes nothing, anywhere. */
  createsNothing: true;
  /** The ONE path a line of this becomes real work through. */
  canonicalPath: string;
  statement: string;
}

export const TEMPLATE_CANONICAL_PATH =
  'HeadquarterOperations.commandMission (capability hq.mission_command, Founder-gated) — then the ' +
  'ordinary orchestrate/claim/approve path for any task under it.';

/**
 * `null` when the product's stored type is not a vocabulary member: there is
 * no template to recommend, and inventing one would be inventing a plan. Note
 * that `productType` on the view is taken from the TEMPLATE, not from the
 * caller's string, so the field's declared `ProductType` is true by
 * construction rather than by assertion.
 */
export function productPlanRecommendation(product: {
  id: string;
  productType: string;
}): ProductPlanRecommendationView | null {
  const template = productPlanTemplateFor(product.productType);
  if (!template) return null;
  return {
    productId: product.id,
    productType: template.productType,
    templateId: template.id,
    templateStatement: template.statement,
    missions: template.missions.map((mission) => ({
      title: mission.title,
      objective: mission.objective,
      planItems: [...mission.planItems],
    })),
    grantsAuthority: false,
    createsNothing: true,
    canonicalPath: TEMPLATE_CANONICAL_PATH,
    statement: TEMPLATE_AUTHORITY_STATEMENT,
  };
}

/* ------------------------------------------------------------------ */
/* The release gate                                                    */
/* ------------------------------------------------------------------ */

/**
 * Why a product is not ready to be proposed for release. Categorical, so a
 * blocker is a fact about recorded rows and never a judgement, a score or a
 * percentage.
 */
export const PRODUCT_RELEASE_BLOCKERS = deepFreeze([
  'lifecycle_before_release_candidate',
  'no_release_candidate_artifact',
  'no_specification_artifact',
  'no_test_report_artifact',
] as const);
export type ProductReleaseBlockerCode = (typeof PRODUCT_RELEASE_BLOCKERS)[number];

const RELEASE_BLOCKER_TEXT: Record<ProductReleaseBlockerCode, string> = {
  lifecycle_before_release_candidate:
    'The product has not reached release_candidate. The lifecycle state is a record of where the product ' +
    'is; it is not itself permission to release.',
  no_release_candidate_artifact:
    'No release_candidate artifact version is registered, so there is no identified thing to release.',
  no_specification_artifact:
    'No specification artifact version is registered, so what the product was meant to do is not recorded.',
  no_test_report_artifact:
    'No test_report artifact version is registered, so what was actually established about it is not recorded.',
};

export interface ProductReleaseBlocker {
  code: ProductReleaseBlockerCode;
  statement: string;
}

/**
 * The statement every readiness read carries, verbatim. It is deliberately
 * blunt: readiness is an OBSERVATION about recorded rows, and an empty
 * blocker list is not an approval, not an authorization and not a release.
 */
export const PRODUCT_RELEASE_GATE_STATEMENT =
  'Readiness is an observation about what is recorded, never an authorization. HQ has no product release ' +
  'path: publishing, deploying or distributing anything is an EXTERNAL ACTION and has exactly one route — ' +
  'the Phase 8 gateway — where it is risk-assessed, bound to a canonical task, requires a valid Founder ' +
  'approval over the exact payload digest, is re-validated by the Intent Guard immediately before the ' +
  'call, and is stopped by any engaged kill switch. Nothing in the Product Factory can execute, and an ' +
  'empty blocker list below changes none of that.';

export interface ProductReleaseReadinessView {
  productId: string;
  lifecycle: ProductLifecycleState;
  blockers: ProductReleaseBlocker[];
  /** Every recorded artifact kind, so the reader sees what the blockers are derived from. */
  artifactKinds: ProductArtifactKind[];
  /** ALWAYS false. This read authorizes nothing, whatever the blockers say. */
  authorizesRelease: false;
  /** The only path an actual release could take. */
  externalActionPath: 'phase_8_action_gateway';
  statement: string;
}

/** PURE. Blockers are facts about the derived record, computed from nothing else. */
export function productReleaseReadiness(product: ProductRecord): ProductReleaseReadinessView {
  const kinds = new Set(product.artifacts.map((artifact) => artifact.kind));
  const blockers: ProductReleaseBlocker[] = [];
  const add = (code: ProductReleaseBlockerCode): void => {
    blockers.push({ code, statement: RELEASE_BLOCKER_TEXT[code] });
  };
  const at = PRODUCT_LIFECYCLE_STATES.indexOf(product.lifecycle);
  if (at < PRODUCT_LIFECYCLE_STATES.indexOf('release_candidate')) add('lifecycle_before_release_candidate');
  if (!kinds.has('release_candidate')) add('no_release_candidate_artifact');
  if (!kinds.has('specification')) add('no_specification_artifact');
  if (!kinds.has('test_report')) add('no_test_report_artifact');
  return {
    productId: product.id,
    lifecycle: product.lifecycle,
    blockers,
    artifactKinds: [...kinds].sort(),
    authorizesRelease: false,
    externalActionPath: 'phase_8_action_gateway',
    statement: PRODUCT_RELEASE_GATE_STATEMENT,
  };
}

/* ------------------------------------------------------------------ */
/* The snapshot section                                                */
/* ------------------------------------------------------------------ */

/**
 * What the UNAUTHENTICATED artifact may say about the Product Factory.
 *
 * COUNTS OVER CLOSED VOCABULARIES, and nothing else: no product name, no
 * problem statement, no target user, no artifact name, no locator, no digest,
 * no id and no free text of any kind. A product name is a company plan, and
 * the Phase 9/11 rule applies unchanged — an unauthenticated artifact has no
 * vocabulary that classifies free text for an unauthenticated reader, so it
 * publishes none.
 *
 * The three maps are keyed by their CLOSED VOCABULARY plus the one extra
 * member `unrecognized`, and by nothing else. That last key is what makes the
 * shape closed rather than merely intended: the values being counted come from
 * stored columns, and `hq_products` / `hq_product_events` /
 * `hq_product_artifacts` are append-only ledgers on which an APPEND is the
 * write the triggers deliberately permit. Before this bucket existed, a row
 * carrying free text in `product_type`, `to_state` or `kind` became an object
 * KEY here — publishing that text to an unauthenticated reader and corrupting
 * the count beside it, because `+= 1` on an absent key is `NaN` and `NaN`
 * serialises as `null`. A value outside the vocabulary is now counted as
 * exactly what HQ knows about it — that it is not one of these — and its text
 * is never carried.
 */
export interface ProductFactorySnapshotView {
  /** False when this database carries no Phase 12 schema; counts are then 0 by absence. */
  storePresent: boolean;
  products: number;
  byType: Record<ProductSnapshotBucket<ProductType>, number>;
  byLifecycle: Record<ProductSnapshotBucket<ProductLifecycleState>, number>;
  artifacts: number;
  artifactsByKind: Record<ProductSnapshotBucket<ProductArtifactKind>, number>;
  note: string;
}

/**
 * The one bucket that is not a vocabulary member. Named `unrecognized` rather
 * than `other` or `unknown`: it is a statement that HQ did not recognise the
 * stored value, not a category of product.
 */
export const PRODUCT_SNAPSHOT_UNRECOGNIZED = 'unrecognized';
export type ProductSnapshotBucket<T extends string> = T | typeof PRODUCT_SNAPSHOT_UNRECOGNIZED;

export const PRODUCT_SNAPSHOT_NOTE =
  'Counts over closed vocabularies only. This artifact carries no product name, problem statement, target ' +
  'user, artifact name, locator, digest or id — the Product Factory record is a Founder-gated read, and ' +
  'nothing free-text from it is published here. A lifecycle count is a count of records; it is not a ' +
  'statement that anything was released, deployed or published, because nothing in this phase can do that. ' +
  'Each map carries its vocabulary plus one `unrecognized` bucket: a stored value outside the vocabulary is ' +
  'counted there and its text is never carried, so no row can add a key to this artifact.';

function zeroBuckets<T extends string>(vocabulary: readonly T[]): Record<ProductSnapshotBucket<T>, number> {
  return Object.fromEntries([
    ...vocabulary.map((member) => [member, 0]),
    [PRODUCT_SNAPSHOT_UNRECOGNIZED, 0],
  ]) as Record<ProductSnapshotBucket<T>, number>;
}

export function emptyProductFactorySnapshot(storePresent: boolean): ProductFactorySnapshotView {
  return {
    storePresent,
    products: 0,
    byType: zeroBuckets(PRODUCT_TYPES),
    byLifecycle: zeroBuckets(PRODUCT_LIFECYCLE_STATES),
    artifacts: 0,
    artifactsByKind: zeroBuckets(PRODUCT_ARTIFACT_KINDS),
    note: PRODUCT_SNAPSHOT_NOTE,
  };
}

/**
 * PURE. Fold derived records into the snapshot's counts.
 *
 * Every increment goes through a membership check, and the checked value —
 * never the caller's string — is the key. So this function can only ever write
 * keys the empty snapshot already created: the section's key set is a function
 * of the vocabularies, not of the data.
 */
export function summarizeProductFactory(input: {
  storePresent: boolean;
  products: readonly ProductRecord[];
  artifactTotal: number;
  artifactKinds: readonly string[];
}): ProductFactorySnapshotView {
  const view = emptyProductFactorySnapshot(input.storePresent);
  view.products = input.products.length;
  for (const product of input.products) {
    if (isProductType(product.productType)) view.byType[product.productType] += 1;
    else view.byType[PRODUCT_SNAPSHOT_UNRECOGNIZED] += 1;
    if (isProductLifecycleState(product.lifecycle)) view.byLifecycle[product.lifecycle] += 1;
    else view.byLifecycle[PRODUCT_SNAPSHOT_UNRECOGNIZED] += 1;
  }
  view.artifacts = input.artifactTotal;
  for (const kind of input.artifactKinds) {
    if (isProductArtifactKind(kind)) view.artifactsByKind[kind] += 1;
    else view.artifactsByKind[PRODUCT_SNAPSHOT_UNRECOGNIZED] += 1;
  }
  return view;
}
