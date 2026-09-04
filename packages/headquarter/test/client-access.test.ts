/**
 * The shipped access decision, executed (issue #250, Phase 2 Stage 4 §A.6).
 *
 * `ACCESS_VERDICT_JS` and `LOCK_STATE_JS` are embedded verbatim in the
 * immersive page. These tests run THAT source — the same pattern
 * `FRESHNESS_VERDICT_JS` and `CONTROL_GRANT_JS` established — so what is proven
 * here is what a browser actually executes, not a Node re-implementation of it
 * that could quietly diverge.
 *
 * The property under test is fail-closed in both directions: every unknown
 * refuses, and only a 200 that positively states `ok: true` and `founder: true`
 * is allowed through.
 */

import { describe, expect, it } from 'vitest';
import { ACCESS_VERDICT_JS, LOCK_STATE_JS, type AccessVerdict, type LockState } from '../src/client/access.js';

const verdict = new Function(`${ACCESS_VERDICT_JS}; return accessVerdict;`)() as (
  status: number,
  body: unknown,
  transportError: string | null,
) => AccessVerdict;

const lock = new Function(`${LOCK_STATE_JS}; return lockState;`)() as (
  killSwitch: unknown,
) => LockState;

const FOUNDER = { ok: true, authenticated: true, founder: true, message: 'Signed in.' };

describe('the shipped access rule lets exactly one case through', () => {
  it('admits a 200 that positively states ok and founder', () => {
    const result = verdict(200, FOUNDER, null);
    expect(result.state).toBe('ready');
    expect(result.founder).toBe(true);
    // The server's own words, not a paraphrase.
    expect(result.message).toBe('Signed in.');
  });

  it('refuses every truthy-but-not-true variant of the two gate fields', () => {
    const notTrue = ['yes', 1, {}, [], 'true', null, undefined];
    for (const value of notTrue) {
      expect(verdict(200, { ...FOUNDER, ok: value }, null).state, `ok=${String(value)}`).toBe('malformed');
      expect(verdict(200, { ...FOUNDER, founder: value }, null).state, `founder=${String(value)}`).toBe(
        'not_founder',
      );
    }
  });

  it('never reads `authenticated` as a substitute for `founder`', () => {
    // A signed-in non-Founder is the case this deployment is CONFIGURED to
    // refuse, and it must read as configuration working rather than as a fault.
    const result = verdict(200, { ok: true, authenticated: true, founder: false }, null);
    expect(result.state).toBe('not_founder');
    expect(result.founder).toBe(false);
    expect(result.message).toContain('not the mapped Founder');
    expect(result.message).toContain('not an error');
  });
});

describe('every refusal and every unknown fails closed, with the server’s reason', () => {
  it('reports 401 as signed out', () => {
    const result = verdict(401, { ok: true, authenticated: false, message: 'No HQ session.' }, null);
    expect(result.state).toBe('unauthenticated');
    expect(result.message).toBe('No HQ session.');
    expect(result.founder).toBe(false);
  });

  it('reports 403 as refused, carrying the control API’s error message', () => {
    const result = verdict(403, { ok: false, error: { code: 'mutations_disabled', message: 'Writes are off here.' } }, null);
    expect(result.state).toBe('refused');
    expect(result.message).toBe('Writes are off here.');
  });

  it('distinguishes an identity service that did not answer from a refusal', () => {
    // 503 is the host's `step_up_unavailable` shape. Calling it a refusal would
    // send a Founder to fix a permission that is not the problem.
    const result = verdict(503, { ok: false, error: { code: 'step_up_unavailable', message: 'Identity did not answer.' } }, null);
    expect(result.state).toBe('unavailable');
    expect(result.message).toBe('Identity did not answer.');
  });

  it('reports a transport failure as unreachable, naming the failure', () => {
    const result = verdict(0, null, 'Failed to fetch');
    expect(result.state).toBe('unreachable');
    expect(result.message).toContain('Failed to fetch');
    expect(result.message).toContain('no control is drawn');
  });

  it('refuses any other status, and any unreadable body', () => {
    for (const status of [204, 302, 404, 418, 500, 502]) {
      expect(verdict(status, { ok: true, founder: true }, null).state, String(status)).toBe('malformed');
    }
    for (const body of [null, undefined, 'ok', 42, true]) {
      expect(verdict(200, body, null).state, String(body)).toBe('malformed');
    }
  });

  it('sets founder false on every non-ready verdict', () => {
    const cases: [number, unknown, string | null][] = [
      [401, {}, null],
      [403, {}, null],
      [503, {}, null],
      [500, {}, null],
      [200, { ok: true, founder: false }, null],
      [0, null, 'offline'],
    ];
    for (const [status, body, error] of cases) {
      const result = verdict(status, body, error);
      expect(result.state, String(status)).not.toBe('ready');
      expect(result.founder, String(status)).toBe(false);
    }
  });

  it('gives every verdict a label a header chip can show', () => {
    const seen = new Set<string>();
    // Bodies WITHOUT a server message, so what is measured is this module's own
    // fallback wording rather than a fixture's.
    for (const [status, body, error] of [
      [200, { ok: true, authenticated: true, founder: true }, null],
      [200, { ok: true, founder: false }, null],
      [401, {}, null],
      [403, {}, null],
      [503, {}, null],
      [500, {}, null],
      [0, null, 'x'],
    ] as [number, unknown, string | null][]) {
      const result = verdict(status, body, error);
      expect(result.label.length, result.state).toBeGreaterThan(0);
      expect(result.message.length, result.state).toBeGreaterThan(20);
      seen.add(result.state);
    }
    // All seven states are reachable, so none of them is dead code that could
    // be wrong without anything noticing.
    expect(seen.size).toBe(7);
  });
});

describe('the lock banner reports the canonical kill switch and nothing else', () => {
  it('reports a released switch as unlocked', () => {
    expect(lock({ globalEngaged: false, engagedScopes: [] })).toEqual({
      locked: false,
      label: '',
      message: '',
    });
  });

  it('reports the global switch as a hard lock', () => {
    const result = lock({ globalEngaged: true, engagedScopes: [] });
    expect(result.locked).toBe(true);
    expect(result.label).toBe('HQ LOCKED');
    expect(result.message).toContain('No capability may execute');
  });

  it('names the scopes when the lock is partial, from the records the server actually sends', () => {
    // This test used to pass `['github', 'archive']` — plain strings — because
    // the client contract declared `engagedScopes: string[]`. The server sends
    // `{ scope, reason, engagedBy, engagedAt }` records, so the test agreed with
    // the wrong contract and passed while the real banner would have read
    // "engaged for 2 scope(s): [object Object], [object Object]": a security
    // control failing to name what it had locked (Codex round 8).
    //
    // The fixture is now the shape the server produces, taken from
    // `KillSwitchView`. A test whose fixture is a guess proves only that the
    // guess is self-consistent.
    const result = lock({
      globalEngaged: false,
      engagedScopes: [
        { scope: 'github', reason: 'incident', engagedBy: 'founder', engagedAt: '2026-09-04T10:00:00Z' },
        { scope: 'archive', reason: null, engagedBy: null, engagedAt: null },
      ],
    });
    expect(result.locked).toBe(true);
    expect(result.label).toBe('PARTIALLY LOCKED');
    expect(result.message).toContain('github, archive');
    expect(result.message).not.toContain('[object Object]');
  });

  it('counts a scope it cannot name rather than inventing one', () => {
    // Half the truth is still true. An invented scope name on a lock banner
    // would not be, and this is the one banner where being wrong is worst.
    const result = lock({
      globalEngaged: false,
      engagedScopes: [
        { scope: 'github', reason: null, engagedBy: null, engagedAt: null },
        { reason: 'malformed', engagedBy: null, engagedAt: null },
      ],
    });
    expect(result.locked).toBe(true);
    expect(result.message).toContain('2 scope(s)');
    expect(result.message).toContain('github');
    expect(result.message).toContain('1 of them carried no readable scope name');
    expect(result.message).not.toContain('[object Object]');
    expect(result.message).not.toContain('undefined');
  });

  it('claims nothing when the state document carried no kill-switch record', () => {
    // Absent evidence is not evidence of an unlocked HQ; it is absent evidence,
    // and the message says so rather than asserting either way.
    for (const missing of [null, undefined, 'engaged', 7]) {
      const result = lock(missing);
      expect(result.locked, String(missing)).toBe(false);
      expect(result.message, String(missing)).toContain('no kill-switch record');
    }
  });
});
