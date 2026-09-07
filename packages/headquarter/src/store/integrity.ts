/**
 * Phase 13 — HQ store integrity, durability posture and the SAFE-MODE verdict.
 *
 * This module answers exactly one question, categorically: **can HQ still
 * stand behind its own stored truth?** It reads; it never repairs, never
 * migrates and never writes. Repair is a Founder decision made against a
 * verified backup, not something a boot path does on its own.
 *
 * Three deliberate boundaries, because each one is a place a reliability layer
 * usually starts lying:
 *
 * 1. **A finding is a closed vocabulary member, never free text.** Every
 *    finding carries a `detail` string for a human, but the FINDING itself —
 *    the thing a decision is taken on and the only thing that reaches an
 *    unauthenticated artifact — is one of six names.
 *
 * 2. **Blocking is a short, argued list.** Only three findings engage safe
 *    mode: the engine says the file is corrupt, an append-only guard that the
 *    schema declares is missing, or the evidence hash chain does not verify.
 *    Each means HQ's own record cannot be trusted. A referential-integrity
 *    violation and a degraded durability posture are REPORTED and do not
 *    engage safe mode — they are real defects, but neither says the standing
 *    record is false, and treating them as corruption would make safe mode a
 *    thing operators route around instead of a thing they act on.
 *
 * 3. **Cost is stated, not hidden.** `structuralIntegrity` is the cheap half
 *    (three `sqlite_master` reads and four pragmas) and is what a boot can
 *    afford on every construction. `fullIntegrity` adds `integrity_check`,
 *    `foreign_key_check` and a whole-log evidence-chain verification, which
 *    are O(database) and O(log), and it is therefore an explicit act. Which
 *    one produced a verdict is carried ON the verdict, so nobody can mistake a
 *    cheap pass for a full one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { HqDatabase } from './db.js';
import { openHqDatabaseReadOnly } from './db.js';

/* ------------------------------------------------------------------ */
/* Durability requirements                                             */
/* ------------------------------------------------------------------ */

/**
 * What a FILE-backed HQ database is required to run under. WAL plus
 * `synchronous = FULL` is what `connectHqDatabaseUnmigrated` establishes and
 * what the hosted durable owner (`openHqPersistence` in `@factoryos/hq-host`)
 * verifies before it will let a schema write touch the volume.
 *
 * Stated as a requirement HERE too, so the posture can be reported by any
 * process holding a handle — including a local workstation run and the
 * read-only snapshot CLI, neither of which goes through the hosted owner.
 */
export const HQ_DURABILITY_REQUIREMENT = {
  journalMode: 'wal',
  /** SQLite's numeric `synchronous`: 2 is FULL. */
  synchronous: 2,
} as const;

/**
 * The pragma facts, read verbatim. `:memory:` databases legitimately report
 * `journal_mode = memory` and are flagged as such rather than pretended over —
 * an in-memory database is not durable and HQ says so instead of claiming WAL.
 */
export interface HqDurabilityPosture {
  journalMode: string;
  synchronous: number;
  foreignKeys: boolean;
  walAutocheckpoint: number;
  readonly: boolean;
  /** True when this handle is an in-memory database, where durability is not applicable. */
  inMemory: boolean;
  /** True when a FILE-backed handle meets `HQ_DURABILITY_REQUIREMENT`. */
  meetsRequirement: boolean;
}

function pragmaNumber(db: HqDatabase, name: string): number {
  const value = db.pragma(name, { simple: true });
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function readDurabilityPosture(db: HqDatabase): HqDurabilityPosture {
  const journalMode = String(db.pragma('journal_mode', { simple: true }) ?? '').toLowerCase();
  const synchronous = pragmaNumber(db, 'synchronous');
  const foreignKeys = pragmaNumber(db, 'foreign_keys') === 1;
  const walAutocheckpoint = pragmaNumber(db, 'wal_autocheckpoint');
  // `journal_mode = memory` is what SQLite reports for a `:memory:` database;
  // it cannot be switched to WAL and there is nothing durable to require.
  const inMemory = journalMode === 'memory';
  return {
    journalMode,
    synchronous,
    foreignKeys,
    walAutocheckpoint,
    readonly: db.readonly,
    inMemory,
    meetsRequirement:
      inMemory ||
      (journalMode === HQ_DURABILITY_REQUIREMENT.journalMode &&
        synchronous === HQ_DURABILITY_REQUIREMENT.synchronous),
  };
}

/* ------------------------------------------------------------------ */
/* The engine-immutable tables                                         */
/* ------------------------------------------------------------------ */

/**
 * Every append-only ledger whose immutability is held by the ENGINE, with the
 * prefix its triggers are named under.
 *
 * The trio required of each is the one that carries the guarantee: no UPDATE
 * of any column, no DELETE of any row, and a BEFORE INSERT guard that closes
 * REPLACE / UPSERT on the primary identity. A table may carry further guards
 * (the secondary-unique-index guards, `hq_memory`'s supersede rule); those are
 * that module's business and are not re-stated here, because a list that
 * duplicates every trigger name would drift the moment a phase adds one.
 *
 * `hq_mission_plan_items` is deliberately ABSENT: it is legitimately updated
 * when an item is linked to a task, so it carries `no_relink` / `no_respec`
 * guards instead of the trio, and demanding the trio of it would be a false
 * finding. A test pins this list against the live schema, so a future
 * append-only table that is not listed here fails there rather than silently
 * escaping the check.
 */
export const ENGINE_IMMUTABLE_TABLES: readonly { table: string; triggerPrefix: string }[] = [
  { table: 'hq_action_intents', triggerPrefix: 'hq_action_intents' },
  { table: 'hq_action_events', triggerPrefix: 'hq_action_events' },
  { table: 'hq_briefs', triggerPrefix: 'hq_briefs' },
  { table: 'hq_collab_sessions', triggerPrefix: 'hq_collab_sessions' },
  { table: 'hq_collab_participants', triggerPrefix: 'hq_collab_participants' },
  { table: 'hq_collab_contributions', triggerPrefix: 'hq_collab_contributions' },
  { table: 'hq_collab_relations', triggerPrefix: 'hq_collab_relations' },
  { table: 'hq_memory', triggerPrefix: 'hq_memory' },
  { table: 'hq_mission_intents', triggerPrefix: 'hq_mission_intents' },
  { table: 'hq_mission_events', triggerPrefix: 'hq_mission_events' },
  { table: 'hq_orchestration_runs', triggerPrefix: 'hq_orch_runs' },
  { table: 'hq_orchestration_run_items', triggerPrefix: 'hq_orch_run_items' },
  { table: 'hq_project_events', triggerPrefix: 'hq_project_events' },
  { table: 'hq_truth_records', triggerPrefix: 'hq_truth_records' },
  { table: 'hq_truth_verifications', triggerPrefix: 'hq_truth_verifications' },
  { table: 'hq_truth_acceptances', triggerPrefix: 'hq_truth_acceptances' },
  { table: 'hq_truth_relations', triggerPrefix: 'hq_truth_relations' },
  { table: 'hq_products', triggerPrefix: 'hq_products' },
  { table: 'hq_product_events', triggerPrefix: 'hq_product_events' },
  { table: 'hq_product_artifacts', triggerPrefix: 'hq_product_artifacts' },
  { table: 'hq_reliability_runs', triggerPrefix: 'hq_reliability_runs' },
  { table: 'hq_reliability_run_events', triggerPrefix: 'hq_reliability_run_events' },
  { table: 'hq_reliability_backups', triggerPrefix: 'hq_reliability_backups' },
];

/** The three guards every engine-immutable table must carry, by suffix. */
export const REQUIRED_IMMUTABILITY_GUARDS = ['no_rewrite', 'no_erase', 'no_replace'] as const;

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The CLOSED finding vocabulary. Six names, and nothing else may be reported —
 * a finding is what a safe-mode decision is taken on and what a count in the
 * unauthenticated artifact is keyed by, so it can never be a stored string.
 */
export const HQ_INTEGRITY_FINDINGS = [
  'database_integrity_check_failed',
  'append_only_guard_missing',
  'evidence_chain_broken',
  'foreign_key_violations',
  'durability_below_requirement',
  'reliability_schema_absent',
] as const;
export type HqIntegrityFinding = (typeof HQ_INTEGRITY_FINDINGS)[number];

export function isHqIntegrityFinding(value: unknown): value is HqIntegrityFinding {
  return typeof value === 'string' && (HQ_INTEGRITY_FINDINGS as readonly string[]).includes(value);
}

/**
 * The three findings that mean HQ's own record cannot be trusted, and are
 * therefore the ONLY ones that engage safe mode. Argued in the module header;
 * pinned by a test so widening or narrowing it is a deliberate, reviewed act.
 */
export const SAFE_MODE_BLOCKING_FINDINGS: readonly HqIntegrityFinding[] = [
  'database_integrity_check_failed',
  'append_only_guard_missing',
  'evidence_chain_broken',
];

export function findingIsBlocking(finding: HqIntegrityFinding): boolean {
  return SAFE_MODE_BLOCKING_FINDINGS.includes(finding);
}

export interface HqIntegrityObservation {
  finding: HqIntegrityFinding;
  blocking: boolean;
  /**
   * A human-readable detail. Deliberately composed from schema object names,
   * pragma values and counts — never from a row's stored content — so an
   * observation cannot become a channel for record text.
   */
  detail: string;
}

/** How thorough the assessment behind a verdict was. Carried, never inferred. */
export const INTEGRITY_ASSESSMENT_DEPTHS = ['structural', 'full'] as const;
export type IntegrityAssessmentDepth = (typeof INTEGRITY_ASSESSMENT_DEPTHS)[number];

export interface HqIntegrityReport {
  depth: IntegrityAssessmentDepth;
  observations: HqIntegrityObservation[];
  /** True when at least one blocking observation stands. */
  safeMode: boolean;
  durability: HqDurabilityPosture;
}

export const SAFE_MODE_STATEMENT =
  'Safe mode is a statement about HQ’s OWN stored record, not about the outside world. It engages only when ' +
  'the engine reports the file corrupt, an append-only guard the schema declares is missing, or the evidence ' +
  'hash chain does not verify. While engaged HQ still READS and still reconciles, and it refuses the acts ' +
  'that would add to, approve, release or execute against a record it cannot stand behind. It is never ' +
  'cleared by a boot: only a fresh assessment that finds nothing blocking clears it.';

export const INTEGRITY_DEPTH_STATEMENT =
  'A structural assessment reads the schema catalogue and the durability pragmas only — cheap enough to run ' +
  'at every construction. A full assessment additionally runs PRAGMA integrity_check, PRAGMA ' +
  'foreign_key_check and a whole-log evidence-chain verification, which are proportional to the database and ' +
  'to the log and are therefore an explicit act. A structural pass is never reported as a full one.';

/* ------------------------------------------------------------------ */
/* The checks                                                          */
/* ------------------------------------------------------------------ */

function tableNames(db: HqDatabase): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function triggerNames(db: HqDatabase): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Every append-only guard that the schema DECLARES and the file does not have.
 *
 * Only tables that are actually PRESENT are checked. A pre-Phase-N file that
 * never had `hq_products` is not missing a guard on it — that is absence, not
 * tampering, and conflating the two would engage safe mode on every older
 * database HQ has ever been pointed at.
 */
export function missingImmutabilityGuards(db: HqDatabase): string[] {
  const tables = tableNames(db);
  const triggers = triggerNames(db);
  const missing: string[] = [];
  for (const entry of ENGINE_IMMUTABLE_TABLES) {
    if (!tables.has(entry.table)) continue;
    for (const guard of REQUIRED_IMMUTABILITY_GUARDS) {
      const name = `trg_${entry.triggerPrefix}_${guard}`;
      if (!triggers.has(name)) missing.push(name);
    }
  }
  return missing.sort();
}

/**
 * The CHEAP assessment: the schema catalogue and the durability pragmas.
 *
 * Runs no table scan, so it is affordable on every construction of the
 * facade. It can detect the one tamper that matters most — an append-only
 * guard removed from a ledger that still exists — because a dropped trigger is
 * a `sqlite_master` fact, not a data fact.
 */
export function structuralIntegrity(
  db: HqDatabase,
  options: {
    reliabilitySchemaPresent?: boolean;
    /**
     * The missing-guard list AS THE FILE WAS FOUND, observed before this
     * process re-ensured any schema.
     *
     * This matters because the ensure functions are `CREATE TRIGGER IF NOT
     * EXISTS` and therefore RESTORE a dropped guard on every construction. A
     * check run after them would find a healthy file and report one — HQ would
     * silently repair the tamper and then say nothing about it. So the
     * observation is taken first and passed in here, and safe mode engages on
     * what was found rather than on what was subsequently repaired: HQ can
     * re-create the guards it declares, but it cannot know what was done to
     * the file while they were absent.
     */
    guardsMissingAsFound?: readonly string[];
  } = {},
): HqIntegrityReport {
  const observations: HqIntegrityObservation[] = [];
  const durability = readDurabilityPosture(db);

  const missing = options.guardsMissingAsFound
    ? [...options.guardsMissingAsFound]
    : missingImmutabilityGuards(db);
  if (missing.length > 0) {
    observations.push({
      finding: 'append_only_guard_missing',
      blocking: true,
      detail:
        `${missing.length} append-only guard(s) declared by the schema were absent from this file: ` +
        `${missing.join(', ')}. HQ re-creates the guards it declares on every boot, so they may stand again ` +
        `now — but it cannot know what was written while they were gone, so the finding stands until a full ` +
        `assessment says otherwise.`,
    });
  }

  if (!durability.meetsRequirement) {
    observations.push({
      finding: 'durability_below_requirement',
      blocking: false,
      detail:
        `journal_mode=${durability.journalMode}, synchronous=${durability.synchronous}; ` +
        `a file-backed HQ database is required to run WAL + FULL. Reported, not blocking: a degraded ` +
        `durability posture risks the NEXT crash, it does not make the standing record false.`,
    });
  }

  if (options.reliabilitySchemaPresent === false) {
    observations.push({
      finding: 'reliability_schema_absent',
      blocking: false,
      detail:
        'This database carries no Phase 13 run ledger. Observed, never migrated: a read-only handle over an ' +
        'older file reports the absence instead of inventing an empty ledger.',
    });
  }

  return {
    depth: 'structural',
    observations,
    safeMode: observations.some((observation) => observation.blocking),
    durability,
  };
}

/**
 * The FULL assessment. Everything structural, plus the three checks whose cost
 * is proportional to the data: the engine's own corruption check, referential
 * integrity, and a whole-log verification of the hash-chained evidence.
 *
 * `verifyEvidenceChain` is injected rather than imported so this module stays a
 * leaf of `store/` and cannot acquire a dependency on `operator/`. The caller
 * passes `EvidenceLog.verifyChain`, which returns the `seq` of the first entry
 * that does not verify, or null when the whole chain does.
 */
export function fullIntegrity(
  db: HqDatabase,
  options: {
    verifyEvidenceChain?: () => number | null;
    reliabilitySchemaPresent?: boolean;
    /** See `structuralIntegrity`. Omitted here means "check the file as it stands now". */
    guardsMissingAsFound?: readonly string[];
  } = {},
): HqIntegrityReport {
  const structural = structuralIntegrity(db, options);
  const observations = [...structural.observations];

  let integrityVerdict: string;
  try {
    const rows = db.prepare(`PRAGMA integrity_check`).all() as Record<string, unknown>[];
    const values = rows.map((row) => String(Object.values(row)[0] ?? '')).filter((value) => value !== '');
    integrityVerdict = values.length === 1 && values[0] === 'ok' ? 'ok' : values.join('; ');
  } catch (error) {
    integrityVerdict = `integrity_check could not run: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
  if (integrityVerdict !== 'ok') {
    observations.push({
      finding: 'database_integrity_check_failed',
      blocking: true,
      detail: `PRAGMA integrity_check did not return ok: ${integrityVerdict.slice(0, 400)}`,
    });
  }

  try {
    const violations = db.prepare(`PRAGMA foreign_key_check`).all() as unknown[];
    if (violations.length > 0) {
      observations.push({
        finding: 'foreign_key_violations',
        blocking: false,
        detail:
          `PRAGMA foreign_key_check reported ${violations.length} violation(s). Reported, not blocking: a ` +
          `dangling reference is a defect in a relationship, not evidence that a recorded fact is false.`,
      });
    }
  } catch {
    // A handle that cannot run foreign_key_check reports nothing rather than a
    // finding it did not make: an absent check is not a passed one, and it is
    // not a failure either. The depth on the verdict already says what ran.
  }

  if (options.verifyEvidenceChain) {
    let brokenAt: number | null | 'error' = null;
    try {
      brokenAt = options.verifyEvidenceChain();
    } catch {
      brokenAt = 'error';
    }
    if (brokenAt === 'error') {
      observations.push({
        finding: 'evidence_chain_broken',
        blocking: true,
        detail: 'The hash-chained evidence log could not be verified at all; HQ treats an unverifiable chain as a broken one.',
      });
    } else if (brokenAt !== null) {
      observations.push({
        finding: 'evidence_chain_broken',
        blocking: true,
        detail: `The hash-chained evidence log does not verify from entry seq ${brokenAt} onward.`,
      });
    }
  }

  return {
    depth: 'full',
    observations,
    safeMode: observations.some((observation) => observation.blocking),
    durability: structural.durability,
  };
}

/* ------------------------------------------------------------------ */
/* Backup file verification                                            */
/* ------------------------------------------------------------------ */

/** Why a candidate backup file was refused. Closed, categorical. */
export const BACKUP_REFUSAL_REASONS = [
  'path_not_absolute',
  'path_missing',
  'path_is_symlink',
  'path_not_a_regular_file',
  'file_empty',
  'file_too_large',
  'not_a_readable_sqlite_database',
  'integrity_check_failed',
  'not_an_hq_database',
] as const;
export type BackupRefusalReason = (typeof BACKUP_REFUSAL_REASONS)[number];

/**
 * The largest file this verification will hash and open. A bound, not a
 * policy: verification reads the whole file twice (once to digest, once as a
 * database), and an unbounded path argument must not become an unbounded read.
 */
export const MAX_VERIFIED_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The table every HQ database has carried since the foundation wave. Its
 * presence is what makes a valid SQLite file an HQ database rather than some
 * other database that happens to open.
 */
const HQ_MARKER_TABLE = 'hq_events';

export interface BackupVerification {
  verified: boolean;
  refusals: BackupRefusalReason[];
  /** sha256 over the file's bytes. Present only when the bytes were read. */
  digest: string | null;
  sizeBytes: number | null;
  /** How many non-internal tables the opened database carries. */
  schemaTables: number | null;
  integrityVerdict: string | null;
}

const VERIFY_CHUNK_BYTES = 1024 * 1024;

function digestFile(fd: number): { digest: string; size: number } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(VERIFY_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return { digest: hash.digest('hex'), size: position };
}

/**
 * Verify that a path holds a readable, uncorrupted HQ database — the check a
 * restore is worth nothing without.
 *
 * READ-ONLY in the strongest available sense: the file is opened `O_NOFOLLOW`
 * for digesting and through `openHqDatabaseReadOnly` for checking, which asks
 * SQLite itself to refuse writes and refuses to create a missing file. Nothing
 * here migrates, checkpoints or repairs, so pointing it at the LIVE database is
 * safe as well as useless.
 *
 * Path protections are refusals, not exceptions, so a caller gets a
 * categorical reason it can record: not absolute, missing, a symlink, not a
 * regular file, empty, larger than the bound, not a readable SQLite database,
 * failing `integrity_check`, or a database that is not an HQ database at all.
 */
export function verifyHqBackupFile(candidate: string): BackupVerification {
  const empty: BackupVerification = {
    verified: false,
    refusals: [],
    digest: null,
    sizeBytes: null,
    schemaTables: null,
    integrityVerdict: null,
  };
  const target = typeof candidate === 'string' ? candidate.trim() : '';
  if (!target || !path.isAbsolute(target)) {
    return { ...empty, refusals: ['path_not_absolute'] };
  }

  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(target);
  } catch {
    return { ...empty, refusals: ['path_missing'] };
  }
  if (entry.isSymbolicLink()) return { ...empty, refusals: ['path_is_symlink'] };
  if (!entry.isFile()) return { ...empty, refusals: ['path_not_a_regular_file'] };
  if (entry.size === 0) return { ...empty, refusals: ['file_empty'] };
  if (entry.size > MAX_VERIFIED_BACKUP_BYTES) return { ...empty, refusals: ['file_too_large'] };

  let digest: string;
  let sizeBytes: number;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const proof = digestFile(fd);
    digest = proof.digest;
    sizeBytes = proof.size;
  } catch {
    return { ...empty, refusals: ['path_not_a_regular_file'] };
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The digest, or the refusal, is the result; a close failure is not.
      }
    }
  }

  let db: HqDatabase;
  try {
    db = openHqDatabaseReadOnly(target);
  } catch {
    return { ...empty, refusals: ['not_a_readable_sqlite_database'], digest, sizeBytes };
  }
  try {
    // Readability FIRST, and as a real query rather than as an assumption:
    // better-sqlite3 opens lazily, so a file of poetry becomes an error at the
    // first statement rather than at `new Database`. Distinguishing "not a
    // database at all" from "a database that fails its integrity check" is the
    // difference between a wrong path and a lost backup, so the two refusals
    // stay separate.
    let tables: Set<string>;
    try {
      tables = tableNames(db);
    } catch {
      return { ...empty, refusals: ['not_a_readable_sqlite_database'], digest, sizeBytes };
    }

    let integrityVerdict: string;
    try {
      const rows = db.prepare(`PRAGMA integrity_check`).all() as Record<string, unknown>[];
      const values = rows.map((row) => String(Object.values(row)[0] ?? '')).filter((value) => value !== '');
      integrityVerdict = values.length === 1 && values[0] === 'ok' ? 'ok' : values.join('; ');
    } catch (error) {
      // A check that could not run is not a check that passed.
      integrityVerdict = `integrity_check could not run: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
    const refusals: BackupRefusalReason[] = [];
    if (integrityVerdict !== 'ok') refusals.push('integrity_check_failed');
    if (!tables.has(HQ_MARKER_TABLE)) refusals.push('not_an_hq_database');
    return {
      verified: refusals.length === 0,
      refusals,
      digest,
      sizeBytes,
      schemaTables: tables.size,
      integrityVerdict: integrityVerdict.slice(0, 400),
    };
  } finally {
    try {
      db.close();
    } catch {
      // Never trade the verification result for a close failure.
    }
  }
}
