/**
 * Wave 5, correction round seven — HIGH NEW-3: the credential scan's coverage
 * is DERIVED here, and no longer counted by hand.
 *
 * `service.ts` and `PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md` both claimed
 * that every facade write which stores caller text goes through
 * `assertNoCredentialShape`, "29 call sites". The number was a hand count and
 * it was wrong: three writes bounded their text with `missionText` — which
 * checks a LENGTH — and never scanned it.
 *
 *  - `recordVerifiedBackup.note` was live and reachable. Executed against
 *    `d97b8a6`: `GET /api/hq/control/reliability` `200`, then one accepted
 *    `recordVerifiedBackup({ note: 'sk-…' })`, then `500` on every subsequent
 *    read. `hq_reliability_backups` carries `no_rewrite`/`no_erase`, so the
 *    denial is permanent — no DELETE and no UPDATE takes the row back out;
 *  - `recordIntelligenceOutcome.note` is not served today, which makes it
 *    latent rather than harmless: the row is append-only, so the day a view
 *    carries it the route is bricked for ever;
 *  - `disableAiMember.reason` is stored on the member record AND appended to
 *    the evidence chain, where nothing recalls it.
 *
 * The hand count is replaced by the enumeration below, so the claim cannot
 * drift again: every member of the facade that calls `missionText` must also
 * call the scan, computed from the source rather than asserted about it.
 *
 * **This file's predicate was HALF of the round-ten root cause, and it is
 * corrected here rather than left as the second copy of the same mistake**
 * (Wave 5 correction round ten, Medium 2). It asked
 * `/assertNoCredentialShape\(/` over a member body — the identical
 * per-METHOD boolean `facade-write-scan.test.ts` asked — so two independent
 * derived assertions could not catch what either one missed, and three live
 * outages sat underneath both. The per-PARAMETER derivation now lives in
 * `facade-write-scan.test.ts`, which is the file that owns the "every write,
 * every parameter" property; this file keeps the DIFFERENT property it was
 * built for — that a LENGTH bound is never mistaken for a content check — and
 * its predicate accepts either guard, because a member whose whole input goes
 * through `callerTextRefusal` has scanned that text just as surely as one
 * naming the field explicitly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { fileFixture } from './reliability.fixture.js';
import { expectOk } from './application.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { AiMemberRegistry } from '../src/registry/members.js';
import { MemberCapabilityRegistry } from '../src/registry/capabilities.js';
import { ProviderDirectory } from '../src/providers/directory.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(HERE, '..', 'src', 'application', 'service.ts');

/** A credential shape the strict read boundary refuses. */
const CREDENTIAL = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX0123456789';

/**
 * Split `service.ts` into its members — every class method and every
 * module-level function — by the two shapes this file spells them in.
 *
 * A source-level segmentation rather than a type-level one, deliberately: the
 * property under test is "a write that bounds text with `missionText` also
 * scans it", and that is a property of the code as WRITTEN. A future method
 * that adds the one call and forgets the other is reported by name.
 */
function membersOf(source: string): { name: string; line: number; body: string }[] {
  const lines = source.split('\n');
  const startsMember = (line: string): boolean =>
    /^ {2}(?:static )?(?:async )?[#a-zA-Z][\w$]*(?:<[^>]*>)?\(/.test(line);
  const startsTopLevel = (line: string): boolean =>
    /^(?:export )?(?:async )?function [#a-zA-Z]/.test(line) || /^(?:export )?class /.test(line);
  const members: { name: string; line: number; body: string[] }[] = [
    { name: '<module scope>', line: 1, body: [] },
  ];
  lines.forEach((line, index) => {
    if (startsMember(line) || startsTopLevel(line)) {
      members.push({ name: line.trim().split('(')[0], line: index + 1, body: [] });
    }
    members[members.length - 1].body.push(line);
  });
  return members.map((member) => ({ name: member.name, line: member.line, body: member.body.join('\n') }));
}

describe('every facade write that bounds caller text also scans it', () => {
  it('derives the coverage from the source instead of counting call sites by hand', () => {
    const source = fs.readFileSync(SERVICE, 'utf8');
    const members = membersOf(source);
    const callers = members.filter(
      // `missionText`'s own DEFINITION is not one of its callers.
      (member) => /missionText\(/.test(member.body) && member.name !== 'function missionText',
    );
    const unscanned = callers
      .filter((member) => !/assertNoCredentialShape\(|callerTextRefusal\(/.test(member.body))
      .map((member) => `${member.name} @ service.ts:${member.line}`);
    // The whole point: named, not counted. A future write that bounds text and
    // forgets the scan is reported here by name.
    expect(unscanned).toEqual([]);
    // A floor, so a narrowing of the segmentation is visible rather than
    // quietly passing over an empty set. 29 facade members call `missionText`
    // at this head; the three the round-seven review found were
    // `recordVerifiedBackup`, `recordIntelligenceOutcome` and `disableAiMember`.
    expect(callers.length).toBeGreaterThanOrEqual(29);
    for (const name of ['recordVerifiedBackup', 'recordIntelligenceOutcome', 'disableAiMember']) {
      expect(
        callers.map((member) => member.name),
        name,
      ).toContain(name);
    }
  });

  it('refuses the three writes the hand count had missed', async () => {
    const fx = fileFixture();
    try {
      const backupPath = path.join(fx.dir, 'scanned.sqlite');
      await fx.db.backup(backupPath);
      const backup = fx.ops.recordVerifiedBackup({
        backupPath,
        requestedBy: 'founder',
        note: `recovery point ${CREDENTIAL}`,
      });
      expect(backup.ok).toBe(false);
      if (backup.ok) throw new Error('unreachable');
      expect(backup.error.code).toBe('invalid_input');

      // `disableAiMember` is reachable only on a facade built WITH the member
      // registry — which `src/cli/workforce.ts` builds on every actor-attributed
      // action. So the reachability the review left open is answered here by
      // constructing the facade the CLI constructs, rather than by argument.
      const workforce = new HeadquarterOperations(fx.db, {
        aiMemberRegistry: new AiMemberRegistry(
          fx.db,
          new ProviderDirectory(),
          new MemberCapabilityRegistry(fx.db),
        ),
      });
      const member = workforce.disableAiMember({
        memberId: 'nobody',
        reason: `standing down ${CREDENTIAL}`,
        founderId: 'founder',
      });
      expect(member.ok).toBe(false);
      if (member.ok) throw new Error('unreachable');
      // The credential refusal comes BEFORE the registry lookup, so an unknown
      // member id cannot be what answered.
      expect(member.error.code).toBe('invalid_input');
      expect(member.error.message).toContain('credential');

      const outcome = fx.ops.recordIntelligenceOutcome({
        decisionId: 'no-such-decision',
        workerId: 'claude',
        fence: fx.claim.fence,
        result: 'quality_met',
        note: `it went fine ${CREDENTIAL}`,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('unreachable');
      expect(outcome.error.code).toBe('invalid_input');
      expect(outcome.error.message).toContain('credential');

      // The plain note is still accepted: this refuses a credential shape, not
      // a Founder's own words.
      expectOk(
        fx.ops.recordVerifiedBackup({
          backupPath,
          requestedBy: 'founder',
          note: 'nightly recovery point, verified by hand',
        }),
      );
    } finally {
      fx.cleanup();
    }
  });

  it('keeps the Founder reliability route at 200 through the write that used to brick it', async () => {
    const ORIGIN = 'https://hq.example';
    const NOW = new Date('2026-09-07T16:00:00.000Z');
    const account: AuthenticatedAccount = {
      realmId: 'tenant-1',
      accountId: 'user-founder',
      displayName: 'Founder',
      authenticatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    };
    const fixture = fileFixture({ processIdentity: 'the-scan-process' });
    try {
      const deps: ControlApiDeps = {
        ops: fixture.ops,
        founderMap: [{ realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' }],
        allowedOrigins: [ORIGIN],
        secretsEnv: {},
        sessions: { resolve: () => account },
        audit: { record: () => undefined },
        now: () => NOW,
        credentials: { verify: () => 'ok' },
      };
      const read = (): ControlResponse =>
        handleControlRequest(
          {
            method: 'GET',
            path: CONTROL_ROUTES.reliability,
            headers: { referer: `${ORIGIN}/hq/index.html`, host: 'hq.example' },
          } as ControlRequest,
          deps,
        );

      expect(read().status).toBe(200);

      const backupPath = path.join(fixture.dir, 'route.sqlite');
      await fixture.db.backup(backupPath);
      const refused = fixture.ops.recordVerifiedBackup({
        backupPath,
        requestedBy: 'founder',
        note: `recovery point ${CREDENTIAL}`,
      });
      expect(refused.ok).toBe(false);

      // The row the refusal did not write is the whole guarantee: the register
      // is append-only, so an accepted write here is permanent.
      const after = read();
      expect(after.status).toBe(200);
      expect(after.body.ok).toBe(true);
      expect(JSON.stringify(after.body)).not.toContain(CREDENTIAL);
    } finally {
      fixture.cleanup();
    }
  });
});
