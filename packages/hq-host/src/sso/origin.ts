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
 */

export type BackChannelOriginRefusal =
  | 'malformed'
  | 'scheme_not_supported'
  | 'credentials_in_url'
  | 'plaintext_not_loopback';

export type BackChannelOriginCheck =
  | { ok: true; origin: string }
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
 * Decide whether a configured origin may carry back-channel credentials.
 *
 * Returns the origin unchanged on success — trailing slashes trimmed and
 * nothing else. It is deliberately NOT rewritten to `URL.origin`: a deployment
 * that mounts the identity host under a path prefix keeps working, and a
 * validator that silently edited a configured value would be its own hazard.
 */
export function checkBackChannelOrigin(candidate: string): BackChannelOriginCheck {
  const trimmed = candidate.trim().replace(/\/+$/, '');
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
  if (url.protocol === 'https:') return { ok: true, origin: trimmed };
  if (url.protocol !== 'http:') return { ok: false, reason: 'scheme_not_supported' };
  if (isLoopbackHostname(url.hostname)) return { ok: true, origin: trimmed };
  return { ok: false, reason: 'plaintext_not_loopback' };
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
  }
}
