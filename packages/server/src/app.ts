import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import type { SessionUser } from '@factoryos/shared';
import type { Db } from './db/index.js';
import { defaultDbPath } from './db/index.js';
import { AppError } from './util.js';
import { resolveSession } from './services/auth.js';
import type { Ctx } from './services/context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMasterdataRoutes } from './routes/masterdata.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerProductionRoutes } from './routes/production.js';
import { registerCommercialRoutes } from './routes/commercial.js';
import { registerInsightRoutes } from './routes/insights.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerImportRoutes } from './routes/importing.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerOperationsRoutes } from './routes/operations.js';
import {
  registerHeadquarterRoutes,
  registerHeadquarterSite,
  type HeadquarterControlPlane,
} from './routes/headquarter.js';

export const SESSION_COOKIE = 'fos_session';

/**
 * The hostname out of a `Host` header, port removed.
 *
 * An IPv6 literal must be bracketed in a Host header, so the brackets are what
 * makes the port unambiguous. Stripping a trailing `:digits` FIRST — the
 * obvious implementation — corrupts an unbracketed IPv6 address by eating its
 * last hextet, so a colon surviving the strip is treated as "this was an
 * address, not a port" and the original is kept.
 */
export function hostnameFromHeader(hostHeader: string): string {
  const raw = hostHeader.trim().toLowerCase();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(raw);
  // Brackets mean IPv6, so the contents must look like one. Anything else in
  // brackets is malformed and is handed on WITH its brackets, which no private
  // rule can match — malformed input ends up public, never private.
  if (bracketed && bracketed[1]!.includes(':')) return bracketed[1]!;
  const withoutPort = raw.replace(/:\d+$/, '');
  return withoutPort.includes(':') ? raw : withoutPort;
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * IPv6 ranges on which plaintext is legitimate: loopback, unique-local
 * (`fc00::/7`) and link-local (`fe80::/10`), plus IPv4-mapped forms, which are
 * classified by their embedded IPv4 address. Everything else — every globally
 * routable address included — is public.
 */
function isPrivateIpv6(host: string): boolean {
  if (host === '::1' || host === '::') return true;
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  const head = host.split(':')[0] ?? '';
  if (/^f[cd][0-9a-f]{2}$/.test(head)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]$/.test(head)) return true; // fe80::/10 link-local
  return false;
}

/**
 * Hosts on which a plaintext session cookie is still legitimate: a developer's
 * own machine, and the private networks JENIFY OS is designed to run on. A
 * factory server at `http://192.168.1.10:3001` is the normal local-first
 * deployment, not a misconfiguration.
 *
 * Order matters, and one ordering bug is worth naming because it shipped in
 * the first draft: the "a name with no dot is a bare LAN hostname" rule ran
 * before any address parsing, so a public IPv6 literal — all colons, no dots —
 * fell into it and a globally routable host served the session cookie without
 * `Secure` over plaintext. Addresses are now classified as addresses first,
 * and the bare-hostname rule only ever sees a name.
 *
 * Everything unrecognised is PUBLIC, so a parsing gap can only ever add
 * `Secure`, never drop it.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === '') return false; // unknown host ⇒ assume public ⇒ Secure
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  if (host.includes(':')) return isPrivateIpv6(host);
  // Not a hostname at all (stray brackets, spaces, control characters) ⇒
  // public. Without this the bare-hostname rule below would swallow anything
  // that merely happens to contain no dot.
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host);
  if (!host.includes('.')) return true; // a bare LAN hostname, e.g. 'mesob-server'
  return false;
}

/**
 * Session-cookie attributes, derived from the request rather than configured.
 *
 * `SameSite=Lax` keeps the cookie off cross-site POSTs — the first of the two
 * CSRF gates; the HQ control API's origin allow-list is the second.
 *
 * `Secure` is the interesting one, and the rule is deliberately inverted from
 * the obvious version. Setting it from `req.protocol === 'https'` alone LOOKS
 * right and is wrong in exactly the deployment that matters: behind a
 * TLS-terminating proxy the request reaches Fastify as plain HTTP, so a hosted
 * site would silently get a non-Secure session cookie. Fastify only believes
 * `x-forwarded-proto` when `trustProxy` is on, and turning that on globally
 * would make `req.ip` spoofable — which is what the login rate limiter is
 * keyed on. Trading a real brute-force defence for a cookie flag is a bad
 * trade, so the flag is derived a different way.
 *
 * The cookie is therefore Secure by DEFAULT, and plaintext only where
 * plaintext is genuinely legitimate: a loopback or private-network host. A
 * public hostname served over plain HTTP gets a Secure cookie the browser then
 * refuses to send — sign-in visibly fails instead of quietly running an
 * authenticated session in the clear. `x-forwarded-proto: https` is also
 * honoured, but only ever to ADD Secure, so a forged header can achieve
 * nothing.
 */
export function sessionCookieOptions(req: FastifyRequest): {
  path: string;
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
} {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]!
    .trim()
    .toLowerCase();
  const https = req.protocol === 'https' || forwarded === 'https';
  const hostname = hostnameFromHeader(String(req.headers.host ?? ''));
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: https || !isPrivateHost(hostname),
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser: SessionUser | null;
  }
}

export interface AppOptions {
  db: Db;
  /**
   * Headquarter browser control, OFF unless a host passes it explicitly.
   *
   * An ordinary tenant deployment (the Mesob pilot included) omits it and
   * gets no HQ routes at all — the control plane is a deliberate act, never
   * something a server acquires by upgrading.
   */
  headquarter?: HeadquarterControlPlane;
  /**
   * Serve the static HQ site from this origin at /hq/, Founder-gated.
   *
   * Requires `headquarter` — the gate reuses the control plane's Founder map
   * and principal registry, so serving the site without the plane is a
   * configuration error and refused loudly rather than served open.
   */
  headquarterSite?: { root: string };
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);
  // Low-bandwidth standard: compress JSON responses over 1 kB (translation
  // bundles, reports, movement lists shrink ~5-8x on weak mobile data).
  app.register(compress, { global: true, threshold: 1024 });

  // Tenant branding assets (logo, flags, stamps) live next to the local DB.
  const brandingDir = path.join(path.dirname(defaultDbPath()), 'branding');
  fs.mkdirSync(brandingDir, { recursive: true });
  app.register(fastifyStatic, { root: brandingDir, prefix: '/branding/' });

  app.decorateRequest('sessionUser', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    req.sessionUser = token ? resolveSession(opts.db, token) : null;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    // Fastify validation errors etc.
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 500) {
      console.error(err);
      reply.status(500).send({ error: 'internal', message: 'Internal server error' });
    } else {
      reply.status(status).send({ error: 'request_error', message: e.message });
    }
  });

  app.get('/api/health', async () => ({ ok: true, service: 'factoryos' }));

  registerAuthRoutes(app, opts.db);
  registerAdminRoutes(app, opts.db);
  registerMasterdataRoutes(app, opts.db);
  registerInventoryRoutes(app, opts.db);
  registerProductionRoutes(app, opts.db);
  registerCommercialRoutes(app, opts.db);
  registerInsightRoutes(app, opts.db);
  registerSyncRoutes(app, opts.db);
  registerImportRoutes(app, opts.db);
  registerAssistantRoutes(app, opts.db);
  registerOnboardingRoutes(app, opts.db);
  registerOperationsRoutes(app, opts.db);
  if (opts.headquarter) registerHeadquarterRoutes(app, opts.db, opts.headquarter);
  if (opts.headquarterSite) {
    if (!opts.headquarter) {
      throw new Error(
        'headquarterSite requires the headquarter control plane: the /hq/ gate is built from ' +
          'the plane\'s Founder map and principal registry, so serving the site without the ' +
          'plane would mean serving it ungated. Refused.',
      );
    }
    registerHeadquarterSite(app, opts.db, opts.headquarter, opts.headquarterSite.root);
  }

  return app;
}

/** Build an authenticated service context or fail with 401. */
export function requireCtx(db: Db, req: FastifyRequest): Ctx {
  if (!req.sessionUser) throw new AppError(401, 'unauthenticated', 'Sign in required');
  return { db, tenantId: req.sessionUser.tenantId, user: req.sessionUser };
}
