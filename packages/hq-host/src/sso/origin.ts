/**
 * What may carry a back-channel credential (Phase 2, Stage 2 correction round).
 *
 * ## The defect this closes
 *
 * The A-4 back channel carries two things a network observer must never see:
 * the shared service secret, on every call, and the Founder's step-up PASSWORD,
 * relayed to the identity host for verification. Both travel in a header and a
 * body rather than a URL, which keeps them out of access logs — and none of
 * that matters if the transport itself is plaintext.
 *
 * `HQ_SSO_IDENTITY_ORIGIN` used to accept any string a deployment put in it, so
 * `http://app.jenifylabs.com` configured a bridge that shipped the service
 * credential and a human password in the clear, with no warning and nothing in
 * the boot banner to distinguish it from the secure spelling.
 *
 * ## The rule
 *
 * HTTPS always. Plaintext ONLY to a genuine loopback address, because that is
 * the one case where "the network" is a socket that never leaves the machine —
 * and it is the case a developer's proof stack actually needs.
 *
 * Loopback means the address, never the name that resembles one:
 *
 *   allowed   https://anything            TLS, wherever it points
 *             http://localhost:3001       the reserved name itself
 *             http://127.0.0.1:3001       127.0.0.0/8, in any spelling Node
 *                                         normalises to it (`http://127.1`)
 *             http://[::1]:3001           IPv6 loopback, bracketed or expanded
 *
 *   refused   http://app.jenifylabs.com   the actual finding: cleartext secrets
 *             http://localhost.evil.test  a NAME that merely starts loopback-ish
 *             http://127.0.0.1.evil.test  same trick with the address
 *             http://localhost@evil.test  userinfo: the host is `evil.test`
 *             http://0.0.0.0:3001         "any address" is not loopback
 *             ws://...  file://...        not a back channel at all
 *
 * `*.localhost` is deliberately NOT allowed either. RFC 6761 reserves it for
 * loopback, but resolution of it is a system-configuration question rather than
 * a guarantee, and this check exists precisely to stop a credential leaving the
 * machine on somebody's DNS answer. Fail closed: the exact forms above, or
 * TLS.
 *
 * Anything unparseable is refused, so a gap in this parser can only ever refuse
 * a working deployment — visibly, at boot — and never quietly permit cleartext.
 *
 * ## Two shapes, two checks (third correction round)
 *
 * A configured value here is one of two things, and they have different rules:
 *
 *   an ORIGIN   `https://app.jenifylabs.com` — scheme, host, optional port, and
 *               NOTHING else. Route constants are appended to it.
 *   a URL       `https://hq.jenifylabs.com/sso/callback` — a complete address,
 *               path included, matched exactly and never appended to.
 *
 * They used to share one check that accepted a path in either, and the two
 * halves of the bridge then disagreed about what a path-mounted origin meant.
 * The back channel built its URL by concatenation (`${origin}${route}`), so
 * `https://app.example/jenify` reached `/jenify/api/sso/hq/redeem` — the prefix
 * preserved. The browser redirect built its URL with `new URL(route, origin)`,
 * and a route constant starts with `/`, so the SAME configuration reached
 * `https://app.example/api/sso/hq/authorize` — the prefix silently dropped. One
 * configured value, two destinations: a handoff that could not complete, and a
 * `redirect_uri` that no allow-list entry matched.
 *
 * The fix is to refuse the ambiguity rather than to support it in two places.
 * Path mounting is not a requirement of A-4 — both halves are addressed as whole
 * origins in every documented deployment — so `checkBackChannelOrigin` now
 * REFUSES a path, a query or a fragment (`path_mounted_origin`), visibly at
 * boot, and returns the canonical `URL.origin`. `checkBackChannelUrl` keeps the
 * transport rules for values that are legitimately whole URLs, such as the exact
 * redirect URIs, and never rewrites them, because those are matched byte for
 * byte against what the browser presents.
 */

export type BackChannelOriginRefusal =
  | 'malformed'
  | 'scheme_not_supported'
  | 'credentials_in_url'
  | 'plaintext_not_loopback'
  /** An ORIGIN carried a path, query or fragment. See "Two shapes" above. */
  | 'path_mounted_origin';

export type BackChannelOriginCheck =
  | { ok: true; origin: string }
  | { ok: false; reason: BackChannelOriginRefusal };

export type BackChannelUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: BackChannelOriginRefusal };

/** 127.0.0.0/8, and nothing else in IPv4. */
function isLoopbackIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

/**
 * Is this the hostname of a loopback address?
 *
 * The input is a WHATWG `URL.hostname`, so it is already lower-cased, already
 * normalised (`127.1` → `127.0.0.1`, `[0:0:0:0:0:0:0:1]` → `[::1]`) and, for
 * IPv6, still bracketed. IPv4-mapped IPv6 arrives in Node's normalised hex form
 * — `[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]` — so the embedded address is
 * classified from the hextets rather than from a dotted string that is no
 * longer there.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === 'localhost') return true;
  if (host === '[::1]') return true;
  const mappedHex = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    // The top hextet holds the first two octets: 0x7f00–0x7fff is 127.x.
    return high >= 0x7f00 && high <= 0x7fff;
  }
  const mappedDotted = /^\[::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})\]$/.exec(host);
  if (mappedDotted) return isLoopbackIpv4(mappedDotted[1]!);
  return isLoopbackIpv4(host);
}

/**
 * The transport rules, applied to any configured value: parseable, no
 * credentials in the URL, and either TLS or a genuine loopback address.
 */
function checkTransport(trimmed: string): { ok: true; url: URL } | { ok: false; reason: BackChannelOriginRefusal } {
  if (!trimmed) return { ok: false, reason: 'malformed' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  // A credential in the URL would be logged by every proxy on the path, and
  // `http://localhost@evil.test` is the reason to check it before the host.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials_in_url' };
  }
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol !== 'http:') return { ok: false, reason: 'scheme_not_supported' };
  if (isLoopbackHostname(url.hostname)) return { ok: true, url };
  return { ok: false, reason: 'plaintext_not_loopback' };
}

/**
 * Decide whether a complete configured URL may carry a back-channel credential
 * or receive a ticket.
 *
 * For values that ARE a whole address — the exact redirect URIs, which
 * legitimately carry `/sso/callback`. Returned unchanged apart from surrounding
 * whitespace: an allow-list entry is compared byte for byte with what the
 * browser presents, so a validator that normalised it would quietly change which
 * links are accepted.
 */
export function checkBackChannelUrl(candidate: string): BackChannelUrlCheck {
  const trimmed = candidate.trim();
  const checked = checkTransport(trimmed);
  return checked.ok ? { ok: true, url: trimmed } : checked;
}

/**
 * Decide whether a configured ORIGIN may carry back-channel credentials.
 *
 * Same transport rules, plus: it must be an origin and nothing more. A path, a
 * query or a fragment is REFUSED (`path_mounted_origin`) rather than half
 * honoured — see "Two shapes, two checks" at the top of this file for the two
 * different URLs one path-mounted origin used to produce.
 *
 * The accepted value is returned as the canonical `URL.origin`, so every caller
 * appends a route constant to the same string. That canonicalisation is a
 * narrowing, never a widening: it can only collapse spellings of the SAME origin
 * (`http://127.1` → `http://127.0.0.1`, `https://h:443` → `https://h`), and
 * anything that would have changed the destination has already been refused.
 */
export function checkBackChannelOrigin(candidate: string): BackChannelOriginCheck {
  const trimmed = candidate.trim().replace(/\/+$/, '');
  const checked = checkTransport(trimmed);
  if (!checked.ok) return checked;
  const { url } = checked;
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'path_mounted_origin' };
  }
  return { ok: true, origin: url.origin };
}

/**
 * Join a checked origin to one of the shared route constants.
 *
 * The ONE way this bridge builds an address, used by both halves and by both
 * channels, so browser redirects and back-channel calls can never again disagree
 * about where a configured origin points. Concatenation rather than
 * `new URL(route, origin)` precisely because the difference between them is what
 * the finding was: with `checkBackChannelOrigin` upstream the two now agree, and
 * this keeps them agreeing if that ever changes.
 */
export function backChannelUrl(origin: string, route: string): string {
  return `${origin.replace(/\/+$/, '')}${route}`;
}

/** A boot-log line an operator can act on, for each refusal. */
export function describeBackChannelOriginRefusal(
  variableName: string,
  candidate: string,
  reason: BackChannelOriginRefusal,
): string {
  const prefix = `[sso] ${variableName}=${candidate} is refused`;
  switch (reason) {
    case 'malformed':
      return `${prefix}: it is not a valid absolute URL. The bridge stays OFF (fail closed).`;
    case 'scheme_not_supported':
      return `${prefix}: only https:// (or http:// to a loopback address) can carry the back channel. The bridge stays OFF (fail closed).`;
    case 'credentials_in_url':
      return `${prefix}: it carries a username or password in the URL, which every proxy on the path would log. The bridge stays OFF (fail closed).`;
    case 'plaintext_not_loopback':
      return (
        `${prefix}: plaintext http:// to a non-loopback host would send the service credential ` +
        `and the Founder step-up password in the clear. Use https://, or a loopback address ` +
        `(localhost, 127.0.0.1, [::1]) for a local proof stack. The bridge stays OFF (fail closed).`
      );
    case 'path_mounted_origin':
      return (
        `${prefix}: it must be an origin — scheme, host and optional port — with no path, query ` +
        `or fragment. A path-mounted origin was honoured on the back channel and dropped on the ` +
        `browser redirect, so the handoff could not complete. Configure the origin alone ` +
        `(https://host[:port]); the routes are appended to it. The bridge stays OFF (fail closed).`
      );
  }
}
