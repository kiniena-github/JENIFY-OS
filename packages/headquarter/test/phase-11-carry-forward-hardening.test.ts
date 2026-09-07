/**
 * The two adjacent carry-forward Low debts Phase 11 hardened, and nothing else.
 *
 * Both were in scope because Phase 11 made them reachable in a new way, and
 * both are pinned here rather than folded into the phase's own suites, so a
 * later reader can see exactly what changed and what it now refuses.
 *
 * (a) `recorded.source` on a memory record was caller-supplied free text that
 *     HQ PERSISTED (`hq_memory.recorded_source`), PUBLISHED
 *     (`memoryBrowserView.recorded.source`, which rides the unauthenticated
 *     artifact for an internal record) and — from Phase 11 — INDEXED and
 *     quotable through search. Nothing bounded it and nothing scanned it:
 *     `recorded.date` and `recorded.confidence` were checked by the store's
 *     validator and `source` fell through both.
 *
 * (b) The reserved-identity-key match was CASE-SENSITIVE, at the browser
 *     boundary (`scanForClientIdentity`) and at the facade
 *     (`normalizeWorkSpec`). A guard written to refuse `requestedBy` let
 *     `RequestedBy` through.
 */

import { describe, expect, it } from "vitest";
import {
  CLIENT_IDENTITY_KEYS,
  isClientIdentityKey,
  scanForClientIdentity,
} from "../src/live/auth.js";
import { MemoryStore } from "../src/memory/store.js";
import { MAX_MEMORY_RECORDED_SOURCE_LENGTH } from "../src/application/memory-command.js";
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
} from "../src/live/control-api.js";
import { CAPS, expectOk } from "./application.fixture.js";
import { searchFixture, type SearchFixture } from "./search-ask.fixture.js";
import type { AuthenticatedAccount } from "../src/live/auth.js";

function memoryCount(fx: SearchFixture): number {
  return (
    fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_memory`).get() as { n: number }
  ).n;
}

/* ------------------------------------------------------------------ */
/* (a) recorded.source is now bounded and scanned                      */
/* ------------------------------------------------------------------ */

describe("a memory record’s recorded.source is bounded and scanned like everything else it persists", () => {
  it("refuses a source past the bound, and writes nothing", () => {
    const fx = searchFixture();
    const before = memoryCount(fx);
    const refused = fx.ops.recordMemory({
      kind: "evidence_note",
      title: "Bounded source probe",
      body: "A note whose date provenance is absurdly long.",
      project: "qos",
      recorded: {
        date: "2026-09-01T00:00:00.000Z",
        confidence: "exact",
        source: "x".repeat(MAX_MEMORY_RECORDED_SOURCE_LENGTH + 1),
      },
      requestedBy: "founder",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invalid_input");
      expect(refused.error.message).toContain("recorded.source exceeds");
    }
    expect(memoryCount(fx)).toBe(before);
  });

  it("refuses credential-shaped text in the source, and writes nothing", () => {
    const fx = searchFixture();
    const before = memoryCount(fx);
    const refused = fx.ops.recordMemory({
      kind: "evidence_note",
      title: "Scanned source probe",
      body: "A note whose date provenance carries a token.",
      project: "qos",
      recorded: {
        date: "2026-09-01T00:00:00.000Z",
        confidence: "exact",
        // The heuristic that guards every other persisted string on this
        // record — the `key: value` shape from operator/evidence.ts. Naming it
        // here rather than asserting a broader scan the code does not perform.
        source: "pulled with token: ghp_abcdefghijklmnopqrstuvwxyz",
      },
      requestedBy: "founder",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invalid_input");
    expect(memoryCount(fx)).toBe(before);
  });

  it("refuses the same content at the STORE, so a trusted composition root cannot bypass the facade", () => {
    const fx = searchFixture();
    const store = new MemoryStore(fx.db);
    const before = memoryCount(fx);
    expect(() =>
      store.record({
        kind: "evidence_note",
        title: "Direct store probe",
        body: "Recorded straight through the store.",
        status: "CURRENT",
        recorded: {
          date: "2026-09-01T00:00:00.000Z",
          confidence: "exact",
          // The heuristic that guards every other persisted string on this
          // record — the `key: value` shape from operator/evidence.ts. Naming it
          // here rather than asserting a broader scan the code does not perform.
          source: "pulled with token: ghp_abcdefghijklmnopqrstuvwxyz",
        },
        recordedBy: "founder",
        project: "qos",
      }),
    ).toThrow();
    expect(memoryCount(fx)).toBe(before);
  });

  it("still accepts an ordinary source, and publishes it unchanged", () => {
    const fx = searchFixture();
    const record = expectOk(
      fx.ops.recordMemory({
        kind: "evidence_note",
        title: "Ordinary source probe",
        body: "A note whose date came from a commit.",
        project: "qos",
        recorded: {
          date: "2026-09-01T00:00:00.000Z",
          confidence: "exact",
          source: "git author date",
        },
        requestedBy: "founder",
      }),
    ).record;
    expect(record.recorded.source).toBe("git author date");
    expect(fx.ops.getMemoryRecord(record.id)!.recorded.source).toBe(
      "git author date",
    );
  });

  it("refuses a non-string source rather than coercing one", () => {
    const fx = searchFixture();
    const refused = fx.ops.recordMemory({
      kind: "evidence_note",
      title: "Typed source probe",
      body: "A note whose date provenance is not text.",
      project: "qos",
      recorded: {
        date: "2026-09-01T00:00:00.000Z",
        confidence: "exact",
        source: 42 as unknown as string,
      },
      requestedBy: "founder",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.error.message).toContain("recorded.source must be text");
  });
});

/* ------------------------------------------------------------------ */
/* (b) reserved identity keys now match case-insensitively             */
/* ------------------------------------------------------------------ */

describe("a reserved identity key is refused whatever its casing", () => {
  it("refuses every reserved key upper-cased, capitalised and mixed", () => {
    for (const key of CLIENT_IDENTITY_KEYS) {
      for (const variant of [
        key.toUpperCase(),
        key.charAt(0).toUpperCase() + key.slice(1),
        [...key].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join(""),
      ]) {
        const scan = scanForClientIdentity({
          instruction: "x",
          [variant]: "founder",
        });
        expect(scan.ok, `key ${variant} must be refused`).toBe(false);
        if (!scan.ok) expect(scan.key).toBe(variant);
        expect(isClientIdentityKey(variant)).toBe(true);
      }
    }
  });

  it("finds a mixed-case claim nested inside an object or an array", () => {
    expect(
      scanForClientIdentity({ order: { meta: { PrincipalId: "founder" } } }).ok,
    ).toBe(false);
    expect(scanForClientIdentity([{ FounderId: "founder" }]).ok).toBe(false);
  });

  it("still leaves an ordinary body alone — folding narrows nothing a real caller uses", () => {
    expect(
      scanForClientIdentity({
        instruction: "Draft the plan",
        route: "CLAUDE",
        project: "mesob",
        title: "Plan",
        collaborationRole: "builder",
        idempotencyKey: "k-1",
        acceptanceCriteria: ["it builds"],
      }).ok,
    ).toBe(true);
    for (const legitimate of [
      "collaborationRole",
      "idempotencyKey",
      "acceptanceCriteria",
      "title",
      "body",
    ]) {
      expect(isClientIdentityKey(legitimate), legitimate).toBe(false);
    }
  });

  it("refuses a mixed-case identity claim on a Phase 11 query string, at the real boundary", () => {
    const fixture = searchFixture();
    const account: AuthenticatedAccount = {
      realmId: "tenant-1",
      accountId: "user-founder",
      displayName: "Founder",
      authenticatedAt: new Date().toISOString(),
    };
    const deps: ControlApiDeps = {
      ops: fixture.ops,
      sessions: { resolve: () => account },
      founderMap: [
        {
          realmId: "tenant-1",
          accountId: "user-founder",
          principalId: "founder",
        },
      ],
      allowedOrigins: ["https://hq.example"],
      secretsEnv: {},
    };
    const response = handleControlRequest(
      {
        method: "GET",
        path: CONTROL_ROUTES.search,
        headers: {
          referer: "https://hq.example/hq/index.html",
          host: "hq.example",
        },
        query: { text: "zircon", PrincipalId: "founder" },
      },
      deps,
    );
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe(
      "client_identity_supplied",
    );
  });

  it("refuses a mixed-case reserved key inside a mission spec payload, at the facade", () => {
    const fx = searchFixture();
    const before = (
      fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_missions`).get() as {
        n: number;
      }
    ).n;
    const result = fx.ops.commandMission({
      title: "Smuggler, capitalised",
      objective: "Smuggle identity past a case-sensitive guard",
      plan: [
        {
          summary: "Work",
          capabilityId: CAPS.readStatus,
          payload: { config: { inner: { RequestedBy: "someone-else" } } },
        },
      ],
      requestedBy: "founder",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain("reserved key 'RequestedBy'");
    expect(
      (
        fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_missions`).get() as {
          n: number;
        }
      ).n,
    ).toBe(before);
  });
});
