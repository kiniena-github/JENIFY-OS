/**
 * The Founder authentication boundary (issue #200, Founder decision of
 * 2026-08-28).
 *
 * Every hostile case the decision names, against the shipped code:
 *
 *   unauthenticated                  no session ⇒ no principal
 *   expired / revoked                the resolver's null is the only answer
 *   forged client principal          a body naming an actor is REFUSED
 *   non-Founder account              signed in, still not the Founder
 *   missing / malformed / ambiguous  the map fails closed, three ways
 *   CSRF                             cross-site and form-post both blocked
 *   step-up                          a stale session cannot approve alone
 */

import { describe, expect, it } from 'vitest';
import {
  checkMutationOrigin,
  loadFounderBindings,
  resolveFounderPrincipal,
  scanForClientIdentity,
  verifyStepUp,
  CLIENT_IDENTITY_KEYS,
  FOUNDER_DENIAL_STATUS,
  STEP_UP_MAX_SESSION_AGE_MS,
  type AuthenticatedAccount,
  type ControlRequest,
  type FounderDenial,
  type SessionResolverPort,
} from '../src/live/auth.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { openMemoryHqDatabase } from '../src/store/db.js';

const NOW = new Date('2026-08-28T16:00:00.000Z');

const ACCOUNT: AuthenticatedAccount = {
  realmId: 'tenant-1',
  accountId: 'user-1',
  displayName: 'Founder',
  authenticatedAt: '2026-08-28T15:00:00.000Z',
};

const MAP = [{ realmId: 'tenant-1', accountId: 'user-1', principalId: 'founder' }];

function request(overrides: Partial<ControlRequest> = {}): ControlRequest {
  return {
    method: 'POST',
    path: '/api/hq/control/orders',
    headers: { origin: 'https://hq.example', 'content-type': 'application/json' },
    body: {},
    ...overrides,
  };
}

function sessions(account: AuthenticatedAccount | null): SessionResolverPort {
  return { resolve: () => account };
}

function principalRegistry(): HumanPrincipalRegistry {
  const registry = new HumanPrincipalRegistry(openMemoryHqDatabase());
  registry.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: ['hq.direct_order'],
    approvalAuthority: true,
    active: true,
  });
  return registry;
}

function denial(result: ReturnType<typeof resolveFounderPrincipal>): FounderDenial {
  if (result.ok) throw new Error('expected a denial, got a resolved Founder');
  return result.reason;
}

describe('identity comes from the session, never from the request', () => {
  it('refuses a body that names any actor, rather than ignoring it', () => {
    // Silently dropping the field would leave the caller believing it worked.
    for (const key of CLIENT_IDENTITY_KEYS) {
      const scan = scanForClientIdentity({ instruction: 'x', [key]: 'founder' });
      expect(scan.ok, `key ${key} must be refused`).toBe(false);
    }
  });

  it('finds an identity claim nested inside an object or an array', () => {
    expect(scanForClientIdentity({ order: { meta: { principalId: 'founder' } } }).ok).toBe(false);
    expect(scanForClientIdentity([{ founderId: 'founder' }]).ok).toBe(false);
  });

  it('leaves an ordinary order body alone', () => {
    expect(
      scanForClientIdentity({
        instruction: 'Draft the plan',
        route: 'CLAUDE',
        project: 'mesob',
        title: 'Plan',
      }).ok,
    ).toBe(true);
  });

  it('has no field on the request shape a credential could be read from', () => {
    // A structural guarantee, not a convention: the boundary literally cannot
    // reach a cookie, a user, or a session off the request it is given.
    const shape = Object.keys(request());
    expect(shape.sort()).toEqual(['body', 'headers', 'method', 'path']);
  });
});

describe('no session, no principal', () => {
  it('refuses an unauthenticated caller with 401', () => {
    const result = resolveFounderPrincipal(request(), {
      sessions: sessions(null),
      principals: principalRegistry(),
      founderMap: MAP,
    });
    expect(denial(result)).toBe('unauthenticated');
    expect(FOUNDER_DENIAL_STATUS.unauthenticated).toBe(401);
  });

  it('treats an expired or revoked session exactly as no session', () => {
    // The host's resolver owns expiry and revocation and answers null for
    // both; there is no second, cached path around it.
    const result = resolveFounderPrincipal(request(), {
      sessions: { resolve: () => null },
      principals: principalRegistry(),
      founderMap: MAP,
    });
    expect(denial(result)).toBe('unauthenticated');
  });
});

describe('the Founder map is explicit, or nothing happens', () => {
  it('refuses when no account is bound at all', () => {
    const result = resolveFounderPrincipal(request(), {
      sessions: sessions(ACCOUNT),
      principals: principalRegistry(),
      founderMap: [],
    });
    expect(denial(result)).toBe('founder_map_unconfigured');
  });

  it('refuses a malformed map instead of skipping the bad entry', () => {
    for (const broken of [
      'not-an-array',
      [{ realmId: 'tenant-1', accountId: 'user-1' }],
      [{ realmId: '', accountId: 'user-1', principalId: 'founder' }],
      [{ realmId: 'tenant-1', accountId: '   ', principalId: 'founder' }],
      [null],
      [['tenant-1', 'user-1', 'founder']],
    ]) {
      const result = resolveFounderPrincipal(request(), {
        sessions: sessions(ACCOUNT),
        principals: principalRegistry(),
        founderMap: broken,
      });
      expect(denial(result), JSON.stringify(broken)).toBe('founder_map_malformed');
    }
  });

  it('refuses an ambiguous map rather than picking a winner', () => {
    const twoPrincipalsOneAccount = [
      { realmId: 'tenant-1', accountId: 'user-1', principalId: 'founder' },
      { realmId: 'tenant-1', accountId: 'user-1', principalId: 'coo' },
    ];
    const twoAccountsOnePrincipal = [
      { realmId: 'tenant-1', accountId: 'user-1', principalId: 'founder' },
      { realmId: 'tenant-1', accountId: 'user-2', principalId: 'founder' },
    ];
    for (const map of [twoPrincipalsOneAccount, twoAccountsOnePrincipal]) {
      const result = resolveFounderPrincipal(request(), {
        sessions: sessions(ACCOUNT),
        principals: principalRegistry(),
        founderMap: map,
      });
      expect(denial(result)).toBe('founder_map_ambiguous');
    }
  });

  it('never infers the Founder from a display name, a username, or a role', () => {
    // The account below is called "Founder" and is the only account there is.
    // It is still not the Founder, because nothing bound it.
    const result = resolveFounderPrincipal(request(), {
      sessions: sessions({ ...ACCOUNT, accountId: 'somebody-else' }),
      principals: principalRegistry(),
      founderMap: MAP,
    });
    expect(denial(result)).toBe('not_founder');
    expect(FOUNDER_DENIAL_STATUS.not_founder).toBe(403);
  });

  it('is keyed on the realm too, so the same account id elsewhere is not the Founder', () => {
    const result = resolveFounderPrincipal(request(), {
      sessions: sessions({ ...ACCOUNT, realmId: 'tenant-2' }),
      principals: principalRegistry(),
      founderMap: MAP,
    });
    expect(denial(result)).toBe('not_founder');
  });

  it('refuses a binding that points at an unregistered or deactivated principal', () => {
    const registry = principalRegistry();
    const unknown = resolveFounderPrincipal(request(), {
      sessions: sessions(ACCOUNT),
      principals: registry,
      founderMap: [{ realmId: 'tenant-1', accountId: 'user-1', principalId: 'ghost' }],
    });
    expect(denial(unknown)).toBe('principal_unknown');

    registry.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: ['hq.direct_order'],
      approvalAuthority: true,
      active: false,
    });
    const inactive = resolveFounderPrincipal(request(), {
      sessions: sessions(ACCOUNT),
      principals: registry,
      founderMap: MAP,
    });
    expect(denial(inactive)).toBe('principal_inactive');
  });

  it('resolves a correctly bound, registered, active Founder', () => {
    const result = resolveFounderPrincipal(request(), {
      sessions: sessions(ACCOUNT),
      principals: principalRegistry(),
      founderMap: MAP,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.founder.principal.id).toBe('founder');
    expect(result.founder.account.accountId).toBe('user-1');
  });

  it('proves identity only — it never reads approvalAuthority', () => {
    // Authorization stays with HeadquarterOperations. A principal with no
    // approval authority still AUTHENTICATES; the queue is what refuses them.
    const registry = principalRegistry();
    registry.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [],
      approvalAuthority: false,
      active: true,
    });
    const result = resolveFounderPrincipal(request(), {
      sessions: sessions(ACCOUNT),
      principals: registry,
      founderMap: MAP,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a valid map and rejects a broken one at the parse boundary', () => {
    expect(loadFounderBindings(undefined)).toEqual({ ok: true, bindings: [] });
    const parsed = loadFounderBindings([
      { realmId: ' tenant-1 ', accountId: ' user-1 ', principalId: ' founder ' },
    ]);
    expect(parsed).toEqual({ ok: true, bindings: MAP });
  });
});

describe('cross-site requests are refused before identity is even resolved', () => {
  it('blocks a mutation from an untrusted origin', () => {
    const result = checkMutationOrigin(
      request({ headers: { origin: 'https://evil.example', 'content-type': 'application/json' } }),
      ['https://hq.example'],
    );
    expect(result).toMatchObject({ ok: false, reason: 'origin_not_allowed' });
  });

  it('blocks a mutation with no Origin header at all', () => {
    const result = checkMutationOrigin(
      request({ headers: { 'content-type': 'application/json' } }),
      ['https://hq.example'],
    );
    expect(result).toMatchObject({ ok: false, reason: 'origin_missing' });
  });

  it("blocks the literal string 'null', which sandboxed frames and file:// send", () => {
    const result = checkMutationOrigin(
      request({ headers: { origin: 'null', 'content-type': 'application/json' } }),
      ['https://hq.example'],
    );
    expect(result).toMatchObject({ ok: false, reason: 'origin_not_allowed' });
  });

  it('blocks the classic cross-site HTML form post on content type', () => {
    // A form can be submitted cross-site with no preflight — but never as JSON.
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      undefined,
    ]) {
      const result = checkMutationOrigin(
        request({ headers: { origin: 'https://hq.example', 'content-type': contentType } }),
        ['https://hq.example'],
      );
      expect(result).toMatchObject({ ok: false, reason: 'content_type_not_json' });
    }
  });

  it('refuses every mutation when no origin is configured', () => {
    const result = checkMutationOrigin(request(), []);
    expect(result).toMatchObject({ ok: false, reason: 'origin_allowlist_empty' });
  });

  it('allows a same-origin JSON mutation, port and case insensitively', () => {
    expect(
      checkMutationOrigin(
        request({
          headers: { origin: 'HTTPS://HQ.EXAMPLE', 'content-type': 'application/json; charset=utf-8' },
        }),
        ['https://hq.example'],
      ).ok,
    ).toBe(true);
    expect(
      checkMutationOrigin(
        request({ headers: { origin: 'http://localhost:3001', 'content-type': 'application/json' } }),
        ['http://localhost:3001'],
      ).ok,
    ).toBe(true);
    // A different port is a different origin.
    expect(
      checkMutationOrigin(
        request({ headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' } }),
        ['http://localhost:3001'],
      ).ok,
    ).toBe(false);
  });

  it('does not gate reads on an origin', () => {
    expect(checkMutationOrigin(request({ method: 'GET', headers: {} }), []).ok).toBe(true);
  });
});

describe('step-up: an old cookie is not consent to an irreversible action', () => {
  const founder = {
    account: ACCOUNT,
    binding: MAP[0]!,
    principal: {
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [],
      approvalAuthority: true,
      active: true,
    },
  };

  it('accepts a genuinely fresh session with no password', () => {
    const fresh = {
      ...founder,
      account: { ...ACCOUNT, authenticatedAt: new Date(NOW.getTime() - 60_000).toISOString() },
    };
    expect(verifyStepUp(fresh, undefined, { now: NOW })).toEqual({ ok: true, via: 'fresh_session' });
  });

  it('demands a password once the session is older than the window', () => {
    const stale = {
      ...founder,
      account: {
        ...ACCOUNT,
        authenticatedAt: new Date(NOW.getTime() - STEP_UP_MAX_SESSION_AGE_MS - 1000).toISOString(),
      },
    };
    expect(verifyStepUp(stale, undefined, { now: NOW })).toMatchObject({
      ok: false,
      reason: 'step_up_required',
    });
  });

  it('refuses a wrong password and accepts the right one', () => {
    const credentials = { verify: (_a: AuthenticatedAccount, p: string) => p === 'correct-horse' };
    expect(verifyStepUp(founder, 'wrong', { now: NOW, credentials })).toMatchObject({
      ok: false,
      reason: 'step_up_failed',
    });
    expect(verifyStepUp(founder, 'correct-horse', { now: NOW, credentials })).toEqual({
      ok: true,
      via: 'password',
    });
  });

  it('refuses rather than waving through when no verifier is wired', () => {
    expect(verifyStepUp(founder, 'anything', { now: NOW })).toMatchObject({
      ok: false,
      reason: 'step_up_unavailable',
    });
  });

  it('treats an unparseable or future timestamp as NOT fresh', () => {
    // A clock or format problem may only ever make the boundary stricter.
    for (const authenticatedAt of ['not-a-date', new Date(NOW.getTime() + 3_600_000).toISOString()]) {
      const odd = { ...founder, account: { ...ACCOUNT, authenticatedAt } };
      expect(verifyStepUp(odd, undefined, { now: NOW }), authenticatedAt).toMatchObject({
        ok: false,
        reason: 'step_up_required',
      });
    }
  });
});
