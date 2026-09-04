/**
 * The typed client boundary (issue #250, Stage 4 §A.3).
 *
 * Every shape the browser runtime is allowed to read off the wire is declared
 * here, once. Before Stage 4 the HQ pages carried their data BAKED IN at build
 * time — `build-site.ts` projected a bundle into HTML and the browser polled a
 * snapshot only to decide whether the page was stale. The browser therefore had
 * no contract with the server at all, because it never asked the server for
 * anything but a freshness stamp.
 *
 * These types are that missing contract. They are deliberately DERIVED from the
 * server's own published shapes rather than restated:
 *
 *   - `HqStateDocument` is `HqSnapshot`, the exact object
 *     `liveSnapshotFromOperations` builds and `assertBrowserSafe` clears. There
 *     is no second projection to fall out of step.
 *   - `ClientSession` mirrors the `GET /api/hq/control/session` body field for
 *     field, and every field on it is optional-or-unknown, because the client
 *     must survive a server that is older, newer, or refusing.
 *
 * Nothing here adds a field the server does not send. A client-side type that
 * invents a field is how a UI starts rendering data nobody produced.
 */

import type { HqSnapshot } from '../live/snapshot.js';
import type { KillSwitchView } from '../application/console.js';

/**
 * The authenticated HQ state document.
 *
 * Served by `GET /api/hq/control/state` — the Stage 4 read route. Identical to
 * the polled snapshot artefact by construction: same builder, same redaction
 * guard, same fabricated-field refusal. What differs is only how it is
 * obtained: this one is fetched per session, behind the Founder gate, instead
 * of being written next to the pages at build time.
 */
export type HqStateDocument = HqSnapshot;

/**
 * What `GET /api/hq/control/session` says about this browser.
 *
 * Every field is optional. The server is the authority on which of them it
 * sends, and a client that requires a field in order to fail closed has the
 * logic backwards — absence must be safe on its own.
 */
export interface ClientSessionControls {
  directOrder?: unknown;
  approve?: unknown;
  deny?: unknown;
  mutationsEnabled?: unknown;
  trustedOriginConfigured?: unknown;
  requestOriginAllowed?: unknown;
  requestOriginSource?: unknown;
  askForChanges?: unknown;
  askForChangesReason?: unknown;
}

export interface ClientSession {
  ok?: unknown;
  authenticated?: unknown;
  founder?: unknown;
  principalId?: unknown;
  displayName?: unknown;
  approvalAuthority?: unknown;
  reason?: unknown;
  message?: unknown;
  controls?: ClientSessionControls;
  routes?: unknown;
}

/**
 * The body of `GET /api/hq/control/state`.
 *
 * ## Why the rooms are projected on the SERVER
 *
 * The obvious design ships the raw state document and projects it in the
 * browser. It was rejected: it would have meant two implementations of
 * "what does the Mission Room show" — one in TypeScript that the tests
 * exercise, and one in the emitted browser string that actually ships — and
 * the no-fake-state rule is exactly the kind of property that rots when the
 * tested copy and the shipped copy are different code.
 *
 * So `hydrate.ts` runs server-side, inside the Founder gate, and this response
 * carries the finished `RoomView[]`. The browser's whole job is to render text
 * it was handed. It cannot invent a row, because it does not know how a row is
 * made.
 *
 * The provenance header (`generatedAt`, `mode`, `note`) travels alongside so
 * the client can state the age and truthfulness of what it is showing without
 * having to re-derive either.
 */
export interface HqClientStateResponse {
  ok: true;
  generatedAt: string;
  /** The state document's own weakest-section provenance. Copied, not asserted. */
  mode: string;
  note: string | null;
  counts: HqStateDocument['counts'];
  /**
   * The canonical kill-switch record, for the lock banner.
   *
   * DERIVED, not restated. This was declared as
   * `{ globalEngaged: boolean; engagedScopes: string[] }` — and the server sends
   * `engagedScopes` as `{ scope, reason, engagedBy, engagedAt }[]`. Because the
   * lie was in the type, `tsc` had nothing to complain about when
   * `securitySection` joined the array straight into a sentence, and the
   * partial-lock banner would have read "engaged for 2 scope(s):
   * [object Object], [object Object]" — a security control failing to name what
   * it had locked (Codex round 8).
   *
   * That is precisely the failure this module's own docstring exists to
   * prevent, three paragraphs above. Pointing at the server's type is what
   * makes the promise real rather than aspirational.
   */
  killSwitch: KillSwitchView;
  rooms: RoomView[];
}

/** The union the runtime holds after one hydration cycle. */
export interface ClientState {
  session: ClientSession | null;
  state: HqStateDocument | null;
}

/**
 * Presentation tone. Structurally the same vocabulary the HQ theme uses, named
 * here so `client/` does not have to import the HTML layer to describe itself.
 */
export type RoomTone = 'accent' | 'info' | 'warn' | 'danger' | 'violet' | 'neutral';

/**
 * How lit a room is in the 3D shell.
 *
 * This is the ONE thing that decides whether a room's panels glow and whether
 * anything in it moves, and it is computed from canonical counts in
 * `hydrate.ts` — never from a timer, never from a random seed, never from "it
 * looks better with something moving". `dark` is the honest default: a room
 * with no recorded state is a dark room.
 */
export type RoomLiveness = 'active' | 'attention' | 'quiet' | 'dark';

export interface RoomMetric {
  label: string;
  /** A count HQ recorded, or a short copied string. Never an estimate. */
  value: number | string;
  hint: string;
  tone: RoomTone;
}

export interface RoomChip {
  label: string;
  tone: RoomTone;
}

export interface RoomRow {
  id: string;
  primary: string;
  secondary: string;
  chips: RoomChip[];
}

/** What a room renders, in both the 3D shell and the server-rendered fallback. */
export interface RoomView {
  roomId: string;
  name: string;
  ordinal: number;
  purpose: string;
  /**
   * `live` only when the room's binding is live AND a state document was
   * actually read. A live-bound room with no document is `awaiting`, not
   * `live` — the distinction between "HQ says zero" and "HQ has not answered"
   * is the whole point of this stage.
   */
  status: 'live' | 'awaiting' | 'not_recorded' | 'later_phase';
  liveness: RoomLiveness;
  metrics: RoomMetric[];
  rows: RoomRow[];
  /** Shown instead of rows when there are none. Always states WHY. */
  emptyMessage: string;
  /** Where this room's content came from, in one line. */
  provenance: string;
  /** The 2D HQ page holding the long form, when one exists. */
  page?: string;
}
