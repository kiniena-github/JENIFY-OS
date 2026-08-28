# HQ Founder authentication — how browser writes are wired

Issue #200. Founder decision of 2026-08-28: Headquarter reuses the existing
JENIFY OS login rather than growing a password system of its own.

This document is the operator-facing half. The reasoning lives next to the code
in `packages/headquarter/src/live/auth.ts` and `live/control-api.ts`.

## What changed

Until now Headquarter could not authenticate a human, and said so: the only
write path was `hq:order`, a trusted-local-admin CLI that asserts a principal id
and authenticates nobody. That is unchanged and is still not a Founder path.

What is new is a second path that *can* say who is acting — a browser request
carrying a live JENIFY OS session, mapped by explicit configuration to a
registered HQ human principal. It is the only thing in the system entitled to
record `actorAuthentication: 'authenticated_os_session'`.

## Turning it on

HQ routes do not exist unless a host asks for them. An ordinary tenant
deployment calls `buildApp({ db })` and has none of them — the Mesob pilot's
shape is untouched.

```ts
buildApp({
  db,
  headquarter: {
    ops,           // HeadquarterOperations over the HQ database
    principals,    // HumanPrincipalRegistry (the HQ human registry)
    founderMap: [{ realmId: '<tenant id>', accountId: '<user id>', principalId: 'founder' }],
    allowedOrigins: ['https://hq.example'],
    secretsEnv: process.env,
    mutationsEnabled: true,   // omit or set false to serve reads only
    audit: { record: (event) => log(event) },
  },
});
```

Four things must be true before a single browser write can happen, and each one
fails closed on its own:

1. **A control plane is passed.** No plane, no routes.
2. **`founderMap` binds a real account.** The key is `(realmId, accountId)` —
   the tenant id and user id from the `users` table, never a username or an
   email, both of which are mutable. An empty map is valid and means the
   controls stay off. A malformed map, an account bound twice, or one principal
   bound to two accounts is refused whole rather than resolved by precedence.
3. **`principalId` names a registered, active HQ human principal**, which is
   also where its originate grants and approval authority live. The binding
   grants nothing by itself.
4. **`allowedOrigins` lists the origin the browser actually uses.** Empty means
   every state-changing request is refused.

### Finding the account id

Do not guess it. It is the `users.id` of the account the Founder signs in with,
in the tenant they sign in to:

```sql
SELECT u.id AS account_id, u.tenant_id AS realm_id, u.username
FROM users u JOIN tenants t ON t.id = u.tenant_id
WHERE u.username = '<the founder''s username>';
```

## The routes

| Method | Path | Who |
|---|---|---|
| GET | `/api/hq/control/session` | any signed-in account (says whether the controls are on, and why not) |
| GET | `/api/hq/control/approvals` | mapped Founder — pending approvals with their action digests |
| POST | `/api/hq/control/orders` | mapped Founder — create a canonical direct order |
| POST | `/api/hq/control/approvals/approve` | mapped Founder — approve the exact rendered action |
| POST | `/api/hq/control/approvals/deny` | mapped Founder — deny, with a reason |

Anything else under the prefix is a 404. There is no generic mutation endpoint,
and no *ask for changes*: the canonical approval model records approve or deny
only, so a third button would show a decision the Operator never saw.

`GET /session` reports which controls are genuinely available, derived from the
resolved principal's own grants — `approve`/`deny` from `approvalAuthority`,
`directOrder` from the `hq.direct_order` origination grant plus the capability
being registered and enabled — and from `mutationsEnabled`. These are
independent registry fields, so being the mapped Founder proves none of them;
the console must draw from this, never from "an account was mapped".

`GET /session` also reports `trustedOriginConfigured`, because with no usable
`allowedOrigins` entry every state-changing request is refused — advertising
the controls in that deployment would be the same false claim in another form.

A denial reason and an approval note are each bounded at 500 characters and
scanned for credential-shaped content **before** the canonical write. A denial
reason is persisted to `op_tasks`, `hq_approvals` and the evidence log; an
approval note is stored in `hq_approvals.decision_note` **and rendered into the
generated console HTML**, and the approve path's evidence payload does not
carry it, so the pre-write check is its only guard.

Requests must be `application/json` and carry a trusted `Origin`. They must NOT
carry `principalId`, `requestedBy`, `founderId`, `actorAuthentication` or any
other identity-shaped field — such a request is refused outright rather than
silently re-attributed, so a client written against a weaker model finds out.

## Step-up

Approving a `founder_gate` or `destructive` action requires a fresh credential:
either a session established in the last five minutes, or the account's password
re-entered as `stepUpPassword`. A long-lived cookie on an unattended machine is
not consent to an irreversible action.

Password attempts run under the same failure budget as sign-in, keyed
`ip|login|hq-stepup:<account>`. The middle component is what the limiter
collapses to a per-source ceiling, so naming it `login` is what genuinely
shares that ceiling with failed sign-ins — in both directions — while the
`hq-stepup:` prefix keeps the per-account buckets distinct. A stolen stale
session therefore cannot be turned into a password oracle, cannot buy a fresh
allowance by moving between the two endpoints, and cannot exhaust the event
loop with repeated scrypt calls. An exhausted budget answers
`429 step_up_rate_limited` — deliberately distinct from a wrong password,
which is `403 step_up_failed`.

Creating an order does not require step-up — it executes nothing, it lands in
`needs_approval` behind the digest gate. Neither does a denial: making it harder
to stop something than to allow it would be backwards.

## Session cookie behaviour

`fos_session` is `HttpOnly` and `SameSite=Lax` everywhere. `Secure` is set by
default and omitted only for loopback and private-network hosts — `localhost`,
`*.localhost`, `*.local`, bare LAN hostnames, IPv4 `127.x`/`10.x`/`172.16–31.x`/
`192.168.x`/`169.254.x`, and IPv6 `::1`, `fc00::/7`, `fe80::/10` and
IPv4-mapped forms of the above. Everything else, a globally routable IPv6
literal included, is public and gets `Secure`; anything unparseable is treated
as public too, so a gap in the classifier can only ever ADD `Secure`. The
local-first deployment — a factory server on the LAN over plain HTTP — keeps
working while a hosted site gets `Secure` even behind a TLS-terminating proxy. `x-forwarded-proto: https` is honoured, but only to add
`Secure`, so forging it achieves nothing.

This is deliberately not `req.protocol === 'https'`: behind a proxy that
terminates TLS the request reaches Fastify as plain HTTP, and that check would
silently drop `Secure` on exactly the deployment that needs it. Trusting
`x-forwarded-proto` generally (Fastify's `trustProxy`) would make `req.ip`
spoofable, and the login rate limiter is keyed on it.

## What did NOT change

Authentication proves identity. It decides nothing about authority, and none of
the following was touched:

`HeadquarterOperations` as the only write facade · the human principal registry
and its originate grants · capability registration and risk classes ·
`founder_gate` policy · no-self-approval · the action digest bound to an
approval · execution provider binding and no-substitution · fencing, nonces and
idempotency · the kill switch · deny-by-default on any unknown capability,
principal, provider or route · the browser-safety guard, which now also runs
over every control-API response.
