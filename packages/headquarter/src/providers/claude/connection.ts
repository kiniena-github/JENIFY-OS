/**
 * Connection Center truth for the GitHub dispatch transport (issue #221).
 *
 * ## Why the existing probes could not answer this
 *
 * `live/connections.ts` gives the `github` catalogue entry the generic
 * configuration probe, which asks one question: is `GITHUB_TOKEN` present? On a
 * GitHub Actions runner that is the right question. On the Founder workstation
 * it is the wrong one twice over — the `gh` CLI keeps its session in the OS
 * keychain, so a fully authenticated machine reports `not_connected`; and an
 * environment variable being set says nothing about whether the session works.
 *
 * So this probe reports what the transport itself observed, on the same ladder
 * the module already defines:
 *
 *   no transport mechanism              → `not_connected`   (nothing to fix with a credential)
 *   mechanism present, nothing asked    → `configured`      (setup evidence only)
 *   live check ran, no session          → `setup_required`  (a real, named observation)
 *   live check ran, session confirmed   → `connected`       (a check ran AND succeeded)
 *
 * ## What `connected` does and does not claim here
 *
 * `gh auth status` is a genuine live check: it asks GitHub about the session and
 * reports the account it belongs to. That is what separates it from the
 * `dispatchable` states elsewhere in this module, which never ask the provider
 * anything. It is still narrow — it establishes an authenticated identity, NOT
 * permission to open an issue in any particular repository — so this probe
 * grants no effective capability, says so in its reason, and leaves
 * repository-level authority to be discovered where it actually matters: at
 * dispatch, which refuses when the account is not the target repository's owner.
 *
 * Fact NAMES only, never values. `GH_AUTH_ACCOUNT` is reported as present or
 * absent, and the account LOGIN (a public identifier, not a credential) appears
 * in the reason so a Founder can see which identity HQ would act as.
 */

import {
  CONNECTION_CATALOG,
  DEFAULT_CONNECTION_VERIFIERS,
  defaultConnectionProbes,
  type ConnectionDescriptor,
  type ConnectionEvidence,
  type ConnectionProbe,
  type ConnectionVerifier,
} from '../../live/connections.js';
import type { GitHubIssueTransport } from './transport.js';

/** The catalogue entry this probe answers for. */
export const GITHUB_DISPATCH_CONNECTION_ID = 'github';

/**
 * Build a Connection Center probe backed by a real transport observation.
 *
 * Takes the transport rather than constructing one, for the same reason
 * `dispatchClaudeTask` does: the states below are then testable without a `gh`
 * install, and a host chooses deliberately which transport its Connection Center
 * is reporting on.
 */
export function githubDispatchProbe(
  descriptor: ConnectionDescriptor,
  transport: GitHubIssueTransport,
): ConnectionProbe {
  return {
    id: descriptor.id,
    probe(_env, now): ConnectionEvidence {
      const status = transport.status();
      const evidenceSource = `providers/claude/transport.ts ${transport.id}.status()`;

      if (!status.available) {
        return {
          state: 'not_connected',
          verification: 'none',
          outcome: 'not_attempted',
          observedFacts: status.observedFacts,
          missingFacts: status.missingFacts,
          effectiveCapabilities: [],
          lastVerifiedAt: null,
          evidenceSource,
          reason: `${descriptor.displayName}: ${status.reason}`,
        };
      }

      if (status.depth !== 'live') {
        // A binary on disk is configuration evidence and nothing more — the same
        // rule the rest of this module applies to a credential-shaped variable.
        return {
          state: 'configured',
          verification: 'configuration',
          outcome: 'not_attempted',
          observedFacts: status.observedFacts,
          missingFacts: status.missingFacts,
          effectiveCapabilities: [],
          lastVerifiedAt: null,
          evidenceSource,
          reason:
            `${descriptor.displayName}: a GitHub transport mechanism is present, but nothing has ` +
            `asked GitHub anything. ${status.reason}`,
        };
      }

      if (!status.authenticated || status.account == null) {
        return {
          state: 'setup_required',
          verification: 'live_check',
          outcome: 'failed',
          observedFacts: status.observedFacts,
          missingFacts: status.missingFacts,
          effectiveCapabilities: [],
          lastVerifiedAt: null,
          evidenceSource,
          reason: `${descriptor.displayName}: ${status.reason}`,
        };
      }

      return {
        state: 'connected',
        verification: 'live_check',
        outcome: 'verified',
        observedFacts: status.observedFacts,
        missingFacts: status.missingFacts,
        // Deliberately empty. The check proved an authenticated identity, not
        // repository permission, and this module's rule is that only what a
        // check actually established may be granted.
        effectiveCapabilities: [],
        lastVerifiedAt: now,
        evidenceSource,
        reason:
          `${descriptor.displayName}: ${status.reason} HQ can dispatch through this session only ` +
          'to a repository this account owns; that is checked again at dispatch, and refused ' +
          'there rather than assumed here.',
      };
    },
  };
}

/**
 * The default probe set, with the GitHub row answered by a real transport
 * observation instead of `GITHUB_TOKEN` presence.
 *
 * Opt-in on purpose, and the transport is passed in rather than constructed:
 * probing a live session spawns a process and asks GitHub a question, which is
 * right on the Founder workstation and wrong inside a static site build or a
 * unit test. A host that has a transport wires it here in one line; a host that
 * has none keeps the honest configuration-only answer it had before.
 */
export function connectionProbesWithGitHubDispatch(
  transport: GitHubIssueTransport,
  catalog: readonly ConnectionDescriptor[] = CONNECTION_CATALOG,
  verifiers: readonly ConnectionVerifier[] = DEFAULT_CONNECTION_VERIFIERS,
): ConnectionProbe[] {
  const descriptor = catalog.find((entry) => entry.id === GITHUB_DISPATCH_CONNECTION_ID);
  const probes = defaultConnectionProbes(catalog, verifiers);
  if (!descriptor) return probes;
  return probes.map((probe) =>
    probe.id === GITHUB_DISPATCH_CONNECTION_ID ? githubDispatchProbe(descriptor, transport) : probe,
  );
}
