/**
 * Wave 5 correction round fifteen, MEDIUM 3 — the credential-scan hole that a
 * property NAME walked through, proved END TO END rather than at unit level.
 *
 * ## What was reproduced at `c23dd0a`
 *
 * `walk` (`live/redaction.ts`) descends into five carriers. Four of them read
 * both the content they hold and the label they hold it under; the plain-object
 * branch read only the content, while the `Map` branch three lines above it
 * explicitly walked its key. `JSON.stringify` publishes both, so the module
 * header's claim that "a snapshot carrying anything that looks like a
 * credential is refused rather than published" was false of a property name.
 *
 * Executed through the real facade at that head, `proposeAction` on a live
 * `gatewayFixture`:
 *
 *  - the credential as a VALUE — `payload: { note: 'ghp_…' }` — was refused
 *    `invalid_input`, `String matches a known credential shape (at
 *    stored_text.payload.note)`;
 *  - the SAME credential as a property NAME — `payload: { 'ghp_…': 'x' }` — was
 *    ACCEPTED, and the row stored in `hq_action_intents` read
 *    `{"payload":"{\"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123\":\"x\"}"}`.
 *
 * That ledger carries a `no_erase` guard, so the credential could not
 * afterwards be removed without DDL, and `proposeAction`'s own comment says the
 * payload "is stored permanently and handed verbatim to an adapter".
 * `assertNoSecretLikeContent` (`operator/evidence.ts`) stringifies the payload
 * and therefore sees the key, but only through the weak `api_key: value`
 * heuristic, which no bare credential shape meets — so the second boundary did
 * not cover it either.
 *
 * ## Why this file exists beside the unit test
 *
 * `live-redaction.test.ts` pins the walk. This pins the CONSEQUENCE: that the
 * fix reaches the write boundary a caller can actually reach, and that the
 * append-only row the hole would have created is never written. The unit test
 * would still pass if a future change routed facade writes around
 * `assertNoCredentialShape`; this one would not.
 */

import { describe, expect, it } from 'vitest';
import { gatewayFixture, startedTask } from './action-gateway.fixture.js';

/** Deliberately not a real credential: the shape is what the scan reads. */
const CREDENTIAL = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';

function storedIntentText(fx: ReturnType<typeof gatewayFixture>): string {
  const rows = fx.db.prepare(`SELECT * FROM hq_action_intents`).all() as Record<string, unknown>[];
  return JSON.stringify(rows);
}

describe('a credential written as a property NAME never reaches an append-only ledger', () => {
  it('is refused by proposeAction exactly as the same credential in a value is', () => {
    const fx = gatewayFixture();
    const started = startedTask(fx);

    // The half that was already correct, asserted so the comparison is real
    // rather than described.
    const asValue = fx.ops.proposeAction({
      taskId: started.taskId,
      adapterId: fx.adapter.id,
      actionType: 'write_note',
      target: 'notes/board',
      payload: { note: CREDENTIAL },
      requestedBy: 'founder',
    });
    expect(asValue.ok).toBe(false);
    if (asValue.ok) throw new Error('unreachable');
    expect(asValue.error.code).toBe('invalid_input');
    expect(asValue.error.message).toContain('known credential shape');

    // The half that was not. At `c23dd0a` this returned ok and wrote the row.
    const asKey = fx.ops.proposeAction({
      taskId: started.taskId,
      adapterId: fx.adapter.id,
      actionType: 'write_note',
      target: 'notes/board',
      payload: { [CREDENTIAL]: 'x' },
      requestedBy: 'founder',
    });
    expect(asKey.ok, 'a credential in a property name was accepted').toBe(false);
    if (asKey.ok) throw new Error('unreachable');
    expect(asKey.error.code).toBe('invalid_input');
    expect(asKey.error.message).toContain('known credential shape');

    // And nothing was written. This is the assertion the finding is really
    // about: `hq_action_intents` is append-only with a `no_erase` guard, so a
    // row accepted here is permanent.
    expect(storedIntentText(fx)).not.toContain(CREDENTIAL);
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_action_intents`).get()).toEqual({ n: 0 });
  });

  it('is refused when the property name is nested inside the payload', () => {
    // The walk descends before it labels, so the nested form is a different
    // path through the same branch and is asserted separately.
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const nested = fx.ops.proposeAction({
      taskId: started.taskId,
      adapterId: fx.adapter.id,
      actionType: 'write_note',
      target: 'notes/board',
      payload: { outer: { inner: { [CREDENTIAL]: 'x' } } },
      requestedBy: 'founder',
    });
    expect(nested.ok).toBe(false);
    expect(storedIntentText(fx)).not.toContain(CREDENTIAL);
  });

  it('still accepts an ordinary payload whose keys are ordinary identifiers', () => {
    // The cost side. A key rule that refused real keys would be a different
    // outage, and every `Record` the control plane composes is keyed by
    // something a caller or a registry chose.
    const fx = gatewayFixture();
    const started = startedTask(fx);
    const fine = fx.ops.proposeAction({
      taskId: started.taskId,
      adapterId: fx.adapter.id,
      actionType: 'write_note',
      target: 'notes/board',
      payload: {
        text: 'hello',
        byWorker: { claude: 2, 'gpt-5-codex': 1 },
        byFinding: { append_only_guard_missing: 1 },
        digest: '3f9a1c2b4d5e6f7081920a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
      },
      requestedBy: 'founder',
    });
    expect(fine.ok, fine.ok ? '' : fine.error.message).toBe(true);
  });
});
