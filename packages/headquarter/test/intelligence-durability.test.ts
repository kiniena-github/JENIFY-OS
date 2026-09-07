/**
 * Phase 14 — DURABILITY. The five secondary-unique append-only guards, pinned.
 *
 * ## Why this file exists
 *
 * The Wave 5 review (MEDIUM finding 2) established two compounding gaps at
 * `c9ddecc`:
 *
 *  1. **Nothing pinned the five `_no_replace_unique` guards.** The reviewer
 *     deleted all five from a scratch copy and the whole suite still passed,
 *     161 files / 3026 tests. Phase 13's equivalent guards ARE pinned, so the
 *     asymmetry was undisclosed as well as real.
 *  2. **The integrity census could not see them.** It matched the trio only,
 *     so a dropped secondary guard produced no `append_only_guard_missing`
 *     finding and engaged no safe mode. That half is fixed in
 *     `store/integrity.ts` and pinned in `reliability-durability.test.ts`.
 *
 * They are load-bearing in FACT, not only in prose: with them removed, an
 * `INSERT OR REPLACE` colliding on `hq_intel_budgets.budget_key` swaps a
 * Founder's spend ceiling and the tier set it permits. Commit `978aee9`
 * claimed that in prose and verified it nowhere. This is that verification.
 *
 * ## What each attack is, and why both matter
 *
 * A REPLACE that collides on a SECONDARY unique index deletes the standing row
 * and inserts the new one. While `recursive_triggers` is OFF — SQLite's
 * default, and what any raw connection gets — the implicit DELETE fires NO
 * `BEFORE DELETE` trigger, so `_no_erase` never runs. The row is not named by
 * `id` and carries no `seq`, so neither `_no_replace` clause fires either. The
 * `_no_replace_unique` guard is the ONLY thing standing there, which is exactly
 * why an unpinned one is worth a finding.
 *
 * `ON CONFLICT (<key>) DO UPDATE` is the other shape of the same intent and is
 * refused as well. Both are exercised, under `recursive_triggers` OFF and ON,
 * from a RAW `better-sqlite3` connection that never ran a line of this
 * repository's code — the guarantee has to live in the FILE.
 *
 * **Which of these four actually PINS the secondary guard, stated rather than
 * implied.** Deleting the five `_no_replace_unique` triggers from a scratch
 * copy fails `INSERT OR REPLACE` with `recursive_triggers` OFF, and the two
 * exploit tests below, and nothing else here: with recursion ON the implicit
 * DELETE reaches `_no_erase`, and an upsert reaches `_no_rewrite`. Those two
 * assertions are therefore SHAPE coverage — the same intent through the other
 * two doors, refused by whichever guard gets there first — not a second pin on
 * the secondary one. They are kept because a future change that reorders the
 * guards should not silently open either door.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import type { HqDatabase } from '../src/store/db.js';
import {
  INTELLIGENCE_COMMAND_CAPABILITY,
  INTELLIGENCE_TIERS,
  registerIntelligenceCommandCapability,
} from '../src/application/intelligence-command.js';
import { RELIABILITY_COMMAND_CAPABILITY } from '../src/application/reliability-command.js';

/** Every Phase 14 ledger, with the SECONDARY unique column its guard defends. */
const SECONDARY_UNIQUE = [
  { table: 'hq_intel_model_observations', keyColumn: 'observation_key', guard: 'trg_hq_intel_obs_no_replace_unique' },
  { table: 'hq_intel_budgets', keyColumn: 'budget_key', guard: 'trg_hq_intel_budgets_no_replace_unique' },
  { table: 'hq_intel_decisions', keyColumn: 'decision_key', guard: 'trg_hq_intel_decisions_no_replace_unique' },
  {
    table: 'hq_intel_decision_outcomes',
    keyColumn: 'outcome_key',
    guard: 'trg_hq_intel_outcomes_no_replace_unique',
  },
  { table: 'hq_intel_cost_entries', keyColumn: 'entry_key', guard: 'trg_hq_intel_costs_no_replace_unique' },
] as const;

/**
 * A file-backed HQ carrying exactly one row in each of the five Phase 14
 * ledgers. A trigger on an empty table fires for nothing, and a vacuously
 * passing assertion is worse than no assertion.
 */
function populated(): ReturnType<typeof fileFixture> {
  const fx = fileFixture({ processIdentity: 'the-intel-durability-process' });
  registerIntelligenceCommandCapability(fx.db);
  fx.principals.register({
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
  expectOk(
    fx.ops.setIntelligenceBudget({
      scopeKind: 'deployment',
      scopeId: 'deployment',
      window: 'total',
      ceilingMinorUnits: 1000,
      currency: 'USD',
      permittedTiers: ['deterministic_local'],
      setBy: 'founder',
    }),
  );
  // A second, higher version so the permitted set admits the tier the
  // side-effect task's floor demands. `latestBudgetFor` takes the max version.
  expectOk(
    fx.ops.setIntelligenceBudget({
      scopeKind: 'deployment',
      scopeId: 'deployment',
      window: 'total',
      ceilingMinorUnits: 1000,
      currency: 'USD',
      permittedTiers: [...INTELLIGENCE_TIERS],
      setBy: 'founder',
    }),
  );
  expectOk(
    fx.ops.recordModelObservation({
      providerId: 'anthropic',
      modelId: 'claude-generic',
      locality: 'cloud',
      availability: 'unknown',
      unitCostProvenance: 'unknown',
      unitCostUnitKind: 'unknown',
      source: 'founder_declared',
      observedBy: 'founder',
    }),
  );
  const decision = expectOk(
    fx.ops.recordIntelligenceDecision({
      taskId: fx.claim.taskId,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      label: 'open the release PR',
      complexity: 'routine',
      contextSize: 'medium',
      workKind: 'coding',
    }),
  ).decision;
  expectOk(
    fx.ops.recordIntelligenceOutcome({
      decisionId: decision.id,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      result: 'quality_met',
    }),
  );
  expectOk(
    fx.ops.recordIntelligenceCost({
      taskId: fx.claim.taskId,
      workerId: fx.claim.workerId,
      fence: fx.claim.fence,
      providerId: 'anthropic',
      provenance: 'billed',
      amountMinorUnits: 250,
      currency: 'USD',
      unitKind: 'requests',
      decisionId: decision.id,
      // A cost entry must DECLARE an identity, so a replay of the same
      // observation is recognized rather than counted twice (Wave 5 correction
      // round five, Low 3).
      idempotencyKey: 'durability-seed',
    }),
  );
  return fx;
}

function firstRow(raw: HqDatabase, table: string): Record<string, unknown> {
  const row = raw.prepare(`SELECT * FROM ${table} ORDER BY seq LIMIT 1`).get() as
    | Record<string, unknown>
    | undefined;
  expect(row, `${table} must carry a row for the guard to fire on`).toBeTruthy();
  return { ...(row as Record<string, unknown>) };
}

/**
 * Build the forged row: the standing row's values, a FRESH `id`, and no `seq`.
 *
 * That is deliberate and it is what makes the assertion mean something. A row
 * naming the existing `id` would be caught by `_no_replace`, and one naming the
 * existing `seq` by its second clause — so an attack that collided on either
 * would prove nothing about the SECONDARY guard. This row collides on the
 * secondary unique key and on nothing else.
 */
function forgedRow(raw: HqDatabase, table: string, mutate: Record<string, unknown> = {}) {
  const row = firstRow(raw, table);
  delete row.seq;
  row.id = `forged-${table}`;
  Object.assign(row, mutate);
  const columns = Object.keys(row);
  return { columns, values: columns.map((column) => row[column]) };
}

describe('the five Phase 14 secondary-unique guards are held by the ENGINE', () => {
  for (const recursive of [false, true]) {
    it(`refuses INSERT OR REPLACE on every secondary unique key (recursive_triggers ${
      recursive ? 'ON' : 'OFF'
    })`, () => {
      const fx = populated();
      try {
        const raw = fx.raw();
        raw.pragma(`recursive_triggers = ${recursive ? 'ON' : 'OFF'}`);
        expect(raw.pragma('recursive_triggers', { simple: true })).toBe(recursive ? 1 : 0);
        for (const target of SECONDARY_UNIQUE) {
          const before = raw.prepare(`SELECT COUNT(*) AS n FROM ${target.table}`).get() as { n: number };
          const { columns, values } = forgedRow(raw, target.table);
          expect(
            () =>
              raw
                .prepare(
                  `INSERT OR REPLACE INTO ${target.table} (${columns.join(', ')})
                   VALUES (${columns.map(() => '?').join(', ')})`,
                )
                .run(...values),
            target.guard,
          ).toThrow(/append-only/);
          expect(
            raw.prepare(`SELECT COUNT(*) AS n FROM ${target.table}`).get(),
            target.table,
          ).toEqual(before);
        }
      } finally {
        fx.cleanup();
      }
    });

    it(`refuses ON CONFLICT DO UPDATE on every secondary unique key (recursive_triggers ${
      recursive ? 'ON' : 'OFF'
    })`, () => {
      const fx = populated();
      try {
        const raw = fx.raw();
        raw.pragma(`recursive_triggers = ${recursive ? 'ON' : 'OFF'}`);
        for (const target of SECONDARY_UNIQUE) {
          const before = raw.prepare(`SELECT COUNT(*) AS n FROM ${target.table}`).get() as { n: number };
          const { columns, values } = forgedRow(raw, target.table);
          expect(
            () =>
              raw
                .prepare(
                  `INSERT INTO ${target.table} (${columns.join(', ')})
                   VALUES (${columns.map(() => '?').join(', ')})
                   ON CONFLICT (${target.keyColumn}) DO UPDATE SET id = excluded.id`,
                )
                .run(...values),
            target.guard,
          ).toThrow(/append-only/);
          expect(
            raw.prepare(`SELECT COUNT(*) AS n FROM ${target.table}`).get(),
            target.table,
          ).toEqual(before);
        }
      } finally {
        fx.cleanup();
      }
    });
  }

  /**
   * The exploit the review actually demonstrated, run forward against the
   * guards that are now pinned: with `trg_hq_intel_budgets_no_replace_unique`
   * removed, a REPLACE on `budget_key` swapped the ceiling from 1000 to
   * 999999999 and the permitted tier from `deterministic_local` to
   * `critical_review`. It cannot.
   */
  it('cannot swap a Founder’s spend ceiling or permitted tier set by REPLACE', () => {
    const fx = populated();
    try {
      const raw = fx.raw();
      raw.pragma('recursive_triggers = OFF');
      const standing = firstRow(raw, 'hq_intel_budgets');
      const { columns, values } = forgedRow(raw, 'hq_intel_budgets', {
        ceiling_minor_units: 999_999_999,
        permitted_tiers: JSON.stringify(['critical_review']),
      });
      expect(() =>
        raw
          .prepare(
            `INSERT OR REPLACE INTO hq_intel_budgets (${columns.join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`,
          )
          .run(...values),
      ).toThrow(/append-only/);

      // The row is byte-identical, through the raw connection...
      expect(firstRow(raw, 'hq_intel_budgets')).toEqual(standing);
      // ...and the ceiling HQ itself reads is the one the Founder set.
      const evaluation = expectOk(
        fx.ops.intelligenceBudgetDecision({
          scopeKind: 'deployment',
          scopeId: 'deployment',
          window: 'total',
        }),
      );
      expect(evaluation.ceilingMinorUnits).toBe(1000);
      expect(evaluation.grantsSpend).toBe(false);
      expect(evaluation.authorizesPaidActivation).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * The corresponding erasure. A REPLACE on `entry_key` would delete a recorded
   * amount AND free the same key to be recorded again — which is how a spend
   * total quietly shrinks.
   */
  it('cannot erase a recorded cost entry by colliding on its entry key', () => {
    const fx = populated();
    try {
      const raw = fx.raw();
      raw.pragma('recursive_triggers = OFF');
      const { columns, values } = forgedRow(raw, 'hq_intel_cost_entries', {
        amount_minor_units: 0,
        provenance: 'unknown',
        currency: null,
      });
      expect(() =>
        raw
          .prepare(
            `INSERT OR REPLACE INTO hq_intel_cost_entries (${columns.join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`,
          )
          .run(...values),
      ).toThrow(/append-only/);
      const entries = fx.ops.listIntelligenceCostEntriesBounded().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.fact.amountMinorUnits).toBe(250);
      expect(entries[0]!.fact.provenance).toBe('billed');
    } finally {
      fx.cleanup();
    }
  });

  /**
   * And the trio is still there beside them, so the secondary guards are an
   * ADDITION to the guarantee rather than a substitute for it.
   */
  it('still refuses UPDATE and DELETE on all five tables from a raw connection', () => {
    const fx = populated();
    try {
      const raw = fx.raw();
      for (const target of SECONDARY_UNIQUE) {
        expect(() => raw.prepare(`UPDATE ${target.table} SET id = 'moved'`).run(), target.table).toThrow(
          /append-only/,
        );
        expect(() => raw.prepare(`DELETE FROM ${target.table}`).run(), target.table).toThrow(
          /append-only/,
        );
      }
    } finally {
      fx.cleanup();
    }
  });
});
