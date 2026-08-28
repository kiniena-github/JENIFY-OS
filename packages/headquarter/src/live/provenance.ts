/**
 * Provenance vocabulary for the LIVE HQ CONTROL read seam (issue #200, scope A).
 *
 * The single honesty rule this file exists to enforce: **a browser must never
 * be able to mistake reconstructed or sample data for live canonical state.**
 * Every section of an HQ snapshot carries one of these, and the UI renders it
 * as a visible chip rather than a footnote.
 *
 * The three modes are deliberately not a spectrum of confidence — they are
 * three different claims about where the bytes came from:
 *
 *   live           read out of the canonical HQ store/operator tables on this
 *                  machine, at `asOf`. The only mode that may be presented as
 *                  operational truth.
 *   reconstructed  rebuilt after the fact from durable external evidence
 *                  (git history, GitHub issues/PRs). Real events, but the
 *                  reconstruction is an inference and may be incomplete.
 *   sample         hand-authored demonstration data. Proves nothing about the
 *                  running system.
 *
 * A provider descriptor is NOT evidence of anything (see `connections.ts`);
 * neither is the mere existence of a member, workflow file, or catalogue
 * entry. `source` must name the thing actually read.
 */

/** Where a snapshot section's data genuinely came from. */
export type SourceMode = 'live' | 'reconstructed' | 'sample';

/** Display labels, kept next to the vocabulary so the UI cannot invent its own. */
export const SOURCE_MODE_LABELS: Record<SourceMode, string> = {
  live: 'LIVE',
  reconstructed: 'RECONSTRUCTED',
  sample: 'SAMPLE',
};

export interface Provenance {
  mode: SourceMode;
  /**
   * What was actually read, in enough detail to check the claim — e.g.
   * `op_tasks via HeadquarterOperations.founderConsole`, not `the database`.
   */
  source: string;
  /** Instant the underlying data was current as of. */
  asOf: string;
  /** Optional operator-facing caveat. Never used to soften a wrong `mode`. */
  note?: string;
}

/** A snapshot section: data plus the claim being made about where it came from. */
export interface SnapshotSection<T> {
  provenance: Provenance;
  data: T;
}

export function section<T>(provenance: Provenance, data: T): SnapshotSection<T> {
  return { provenance, data };
}

/**
 * Weakest mode across a set of sections. A snapshot is only as live as its
 * least-live part, so a bundle carrying one sample section can never present
 * itself as LIVE overall.
 */
export function weakestMode(modes: readonly SourceMode[]): SourceMode {
  if (modes.includes('sample')) return 'sample';
  if (modes.includes('reconstructed')) return 'reconstructed';
  return 'live';
}
