/**
 * The seventeen approved HQ destinations, as one registry (issue #250,
 * Phase 2 Stage 4).
 *
 * ## Why a registry and not seventeen pages
 *
 * The Founder approved a 17-screen HQ. Seventeen hand-written pages would
 * drift: a room could exist in the 3D shell and not in the navigation, or
 * carry a heading in one place and a different one in another, and nothing
 * would catch it. This module is the ONE place a destination is declared —
 * its name, what it is for, where it stands in the building, and, most
 * importantly, **what canonical state it is allowed to claim**. The 3D shell,
 * the server-rendered fallback, the route table and the tests all read this
 * same array, so a room cannot be half-present.
 *
 * ## `binding` is the honesty mechanism
 *
 * Every room states, in code, where its content comes from:
 *
 *   - `live`        — the room projects a named section of the authenticated
 *                     HQ state document and nothing else. `hydrate.ts` is the
 *                     only thing allowed to fill it, and it copies; it never
 *                     derives a status HQ does not record.
 *   - `not_recorded` — HQ's canonical control plane genuinely does not record
 *                     this. The room is routable and says so plainly. It is
 *                     NOT a roadmap promise; it is a statement about today's
 *                     record.
 *   - `later_phase` — the capability belongs to a later roadmap phase. The
 *                     room says that, and draws no control.
 *
 * A room may not be `live` without naming its section, and `hydrate.ts`
 * refuses to render live content for a room that is not `live`. That pairing
 * is what stops Stage 4 from becoming a demo dashboard: a room with no data
 * behind it renders as a room with no data behind it.
 *
 * ## Geometry lives here too
 *
 * The building is procedural. Rooms are placed by ring and index, not by hand,
 * so the plan is reproducible from code, has no untracked asset behind it, and
 * can be re-laid-out without touching the renderer. `scene` in `webgl.ts`
 * projects these coordinates; nothing else knows them.
 */

/** Where a room's content is allowed to come from. */
export type RoomBinding =
  | {
      kind: 'live';
      /**
       * The section of the authenticated state document this room projects.
       * Named, not free text, so `hydrate.ts` can switch on it exhaustively.
       */
      section: RoomSection;
      /** Human-readable provenance, shown on the room itself. */
      source: string;
    }
  | { kind: 'not_recorded'; reason: string }
  | { kind: 'later_phase'; reason: string };

/**
 * The sections of canonical state a room may project.
 *
 * Deliberately the same vocabulary as `HqSnapshot`'s own fields plus the
 * derived-but-not-invented views (`overview`, `projects`, `lanes`,
 * `analytics`, `security`). A derived section is still a projection: it counts
 * and groups rows the state document already carries, and adds no row.
 */
export type RoomSection =
  | 'overview'
  | 'operations'
  | 'missions'
  | 'workforce'
  | 'approvals'
  | 'lanes'
  | 'projects'
  | 'capabilities'
  | 'connections'
  | 'analytics'
  | 'security'
  | 'founder'
  | 'activity';

export interface RoomPlacement {
  /** 0 = the atrium, 1 = the inner ring, 2 = the outer ring. */
  ring: 0 | 1 | 2;
  /** Index within the ring; ignored for the atrium. */
  slot: number;
}

export interface HqRoom {
  /** Stable id. Also the route fragment and the DOM id of the room panel. */
  id: string;
  /** 1..17, matching the Founder's approved screen order. */
  ordinal: number;
  name: string;
  /** One sentence: what this room is FOR. Never a status claim. */
  purpose: string;
  binding: RoomBinding;
  placement: RoomPlacement;
  /**
   * The existing 2D HQ page that holds the long form of this room's subject,
   * where one exists. The immersive shell links to it rather than duplicating
   * it — Stage 4 adds a runtime, it does not fork the site.
   */
  page?: string;
}

/**
 * The approved seventeen, in the Founder's order.
 *
 * The bindings were decided by reading what `liveSnapshotFromOperations`
 * actually reads out of the HQ database, not by what a room's name suggests it
 * ought to show. Three rooms came out `not_recorded` and two `later_phase`;
 * inventing a source for any of them was the one thing this stage may not do.
 */
export const HQ_ROOMS: readonly HqRoom[] = [
  {
    id: 'home',
    ordinal: 1,
    name: 'Main Home',
    purpose: 'The arrival hall. One truthful read of what HQ is holding right now.',
    binding: {
      kind: 'live',
      section: 'overview',
      source: 'counts + provenance mode of the authenticated HQ state document',
    },
    placement: { ring: 0, slot: 0 },
    page: 'index.html',
  },
  {
    id: 'command-room',
    ordinal: 2,
    name: 'Command Room',
    purpose: 'Mission control. What is in flight, what is queued, and what has stopped.',
    binding: {
      kind: 'live',
      section: 'operations',
      source: 'operations section — op_tasks via application/console.founderConsole',
    },
    placement: { ring: 1, slot: 0 },
    page: 'index.html',
  },
  {
    id: 'mission-room',
    ordinal: 3,
    name: 'Mission Room',
    purpose: 'Every recorded mission, by the status the canonical queue holds for it.',
    binding: {
      kind: 'live',
      section: 'missions',
      source: 'operations section — the same canonical task cards, grouped by status',
    },
    placement: { ring: 1, slot: 1 },
    page: 'projects.html',
  },
  {
    id: 'meeting-room',
    ordinal: 4,
    name: 'Meeting Room',
    purpose: 'Where the Executive Room record is read.',
    binding: {
      kind: 'not_recorded',
      reason:
        'HQ’s authenticated client boundary carries tasks, approvals, workers, capabilities, ' +
        'connections and canonical events. Message and transcript text is deliberately NOT on it — ' +
        'the same rule that keeps an order’s instruction text server-side. The Executive Room page ' +
        'renders the recorded transcript from the site bundle; this room links to it rather than ' +
        'reproducing a live feed the client API does not serve.',
    },
    placement: { ring: 1, slot: 2 },
    page: 'executive-room.html',
  },
  {
    id: 'world-network',
    ordinal: 5,
    name: 'World Network',
    purpose: 'Every external service HQ can reach, and the evidence for each claim.',
    binding: {
      kind: 'live',
      section: 'connections',
      source: 'connections section — live/connections.assessConnections over observed facts',
    },
    placement: { ring: 1, slot: 3 },
    page: 'connections.html',
  },
  {
    id: 'departments',
    ordinal: 6,
    name: 'Department Navigation',
    purpose: 'The operating lanes of the company and who is registered in each.',
    binding: {
      kind: 'live',
      section: 'lanes',
      // Said precisely, because the obvious reading of "departments" is a thing
      // HQ does not have. `packages/headquarter/src/organization` models
      // departments, but it is an in-memory engine with no store binding and
      // nothing in the canonical HQ database persists it — so a "department
      // registry" here would be a fabrication. The registered ROLE of every
      // specialist IS canonical and IS persisted, and it is what actually
      // divides the workforce today.
      source:
        'workforce section — the registered role of every specialist in hq_specialists. HQ does ' +
        'not persist a separate department registry; these are the real recorded lanes.',
    },
    placement: { ring: 1, slot: 4 },
    page: 'specialists.html',
  },
  {
    id: 'ai-workforce',
    ordinal: 7,
    name: 'AI Workforce',
    purpose: 'Every registered worker, its vendor, its granted capabilities and whether it is active.',
    binding: {
      kind: 'live',
      section: 'workforce',
      source: 'workforce section — hq_specialists via HeadquarterStore.listSpecialists',
    },
    placement: { ring: 1, slot: 5 },
    page: 'specialists.html',
  },
  {
    id: 'approvals',
    ordinal: 8,
    name: 'Approvals',
    purpose: 'What is waiting on a Founder decision, and the only two decisions the model has.',
    binding: {
      kind: 'live',
      section: 'approvals',
      source: 'operations.approvals — pending approval cards with their action digests',
    },
    placement: { ring: 1, slot: 6 },
    page: 'approvals.html',
  },
  {
    id: 'resources',
    ordinal: 9,
    name: 'Resources',
    purpose: 'The capability registry: what HQ is actually allowed to do, and at what risk class.',
    binding: {
      kind: 'live',
      section: 'capabilities',
      source: 'capabilities section — op_capabilities via CapabilityRegistry.list',
    },
    placement: { ring: 1, slot: 7 },
  },
  {
    id: 'analytics',
    ordinal: 10,
    name: 'Analytics',
    purpose: 'Counting what is recorded. No estimate, no forecast, no synthetic total.',
    binding: {
      kind: 'live',
      section: 'analytics',
      // The wording matters: this room COUNTS rows the state document already
      // carries. It does not compute a rate, a cost, a duration or a
      // completion percentage, because HQ records none of those and
      // `assertNoFabricatedFields` refuses them on the wire.
      source: 'counts over the operations, workforce, capabilities and activity sections',
    },
    placement: { ring: 2, slot: 0 },
  },
  {
    id: 'founder-office',
    ordinal: 11,
    name: 'Founder Office',
    purpose: 'Who this session is, what authority it holds, and what is gated on it.',
    binding: {
      kind: 'live',
      section: 'founder',
      source: 'GET /api/hq/control/session — the resolved principal and its granted controls',
    },
    placement: { ring: 2, slot: 1 },
    page: 'approvals.html',
  },
  {
    id: 'projects',
    ordinal: 12,
    name: 'Projects',
    purpose: 'The projects the canonical event log names, and what each is currently carrying.',
    binding: {
      kind: 'live',
      section: 'projects',
      source: 'activity section — the project recorded on each canonical event',
    },
    placement: { ring: 2, slot: 2 },
    page: 'projects.html',
  },
  {
    id: 'product-factory',
    ordinal: 13,
    name: 'Product Factory',
    purpose: 'Where a JENIFY product would be assembled from HQ’s own output.',
    binding: {
      kind: 'later_phase',
      reason:
        'No product-assembly capability is registered in the canonical capability registry, and ' +
        'no canonical subject kind records product builds. This room is routable and named so the ' +
        'building is complete; it draws no control and claims no state, because there is none to ' +
        'claim. It becomes real when a capability behind it is registered and enabled.',
    },
    placement: { ring: 2, slot: 3 },
  },
  {
    id: 'company-memory',
    ordinal: 14,
    name: 'Company Memory',
    purpose: 'Ask Jenify: the retrieval layer over HQ’s own record.',
    binding: {
      kind: 'later_phase',
      reason:
        'The AI layer is a later roadmap phase and is gated on the Founder AI milestone. HQ’s ' +
        'memory module has no query surface on the authenticated client boundary, and no ' +
        'natural-language route exists on the control API. Drawing an ask box here would be a ' +
        'button that cannot act.',
    },
    placement: { ring: 2, slot: 4 },
    page: 'archive.html',
  },
  {
    id: 'research',
    ordinal: 15,
    name: 'Research / R&D',
    purpose: 'Where investigation work would be tracked apart from delivery work.',
    binding: {
      kind: 'not_recorded',
      reason:
        'HQ records tasks, not task CLASSES: nothing in the canonical queue distinguishes a ' +
        'research task from a delivery task, so any split shown here would be invented. Research ' +
        'work that exists today appears in the Mission Room like every other recorded task.',
    },
    placement: { ring: 2, slot: 5 },
  },
  {
    id: 'security-center',
    ordinal: 16,
    name: 'Security Center',
    purpose: 'The posture of this session and this deployment. Never the secrets behind it.',
    binding: {
      kind: 'live',
      section: 'security',
      source:
        'GET /api/hq/control/session controls + the kill switch and connection auth mechanisms ' +
        'from the state document. Secret PRESENCE only; no value ever crosses this boundary.',
    },
    placement: { ring: 2, slot: 6 },
    page: 'connections.html',
  },
  {
    id: 'connections',
    ordinal: 17,
    name: 'Settings / Connections',
    purpose: 'How this deployment is wired, and what each wire is proven to be.',
    binding: {
      kind: 'live',
      section: 'connections',
      source: 'connections section + the capability enablement flags',
    },
    placement: { ring: 2, slot: 7 },
    page: 'connections.html',
  },
];

/** Route fragment for a room. One scheme, used by the shell and the tests. */
export function roomRoute(roomId: string): string {
  return `#/room/${roomId}`;
}

/**
 * The room a route fragment names, or null.
 *
 * Deliberately strict: an unknown room, a malformed fragment and an empty hash
 * all resolve to null, and the shell treats null as "show the atrium" rather
 * than guessing at the nearest match. A spatial UI that silently substitutes a
 * different room than the URL asked for is lying about where you are.
 */
export function roomForRoute(hash: string): HqRoom | null {
  const match = /^#\/room\/([a-z0-9-]+)$/.exec(hash.trim());
  if (!match) return null;
  return HQ_ROOMS.find((room) => room.id === match[1]) ?? null;
}

export function roomById(id: string): HqRoom | undefined {
  return HQ_ROOMS.find((room) => room.id === id);
}

/** Rooms that project canonical state, in Founder order. */
export function liveRooms(): HqRoom[] {
  return HQ_ROOMS.filter((room) => room.binding.kind === 'live');
}

/* ------------------------------------------------------------------ */
/* Procedural placement                                                */
/* ------------------------------------------------------------------ */

/** Ring radii in world units. The atrium sits at the origin. */
export const RING_RADIUS: Record<0 | 1 | 2, number> = { 0: 0, 1: 30, 2: 54 };

/** Half-extent of a room volume, in world units. */
export const ROOM_HALF_SPAN = 7.5;

export interface RoomAnchor {
  /** World position of the room's centre. */
  x: number;
  z: number;
  /** Radians, measured from +X toward +Z. Used to face the room inward. */
  angle: number;
  /** Where the camera stands to look INTO the room, on the atrium side. */
  cameraX: number;
  cameraZ: number;
  cameraY: number;
}

/**
 * Where a room stands, computed rather than authored.
 *
 * The inner ring is offset by half a slot against the outer one, so no outer
 * room hides directly behind an inner room from the atrium — the arrangement
 * you would design by hand, arrived at by construction so it cannot rot.
 */
export function roomAnchor(room: HqRoom): RoomAnchor {
  const { ring, slot } = room.placement;
  if (ring === 0) {
    return { x: 0, z: 0, angle: 0, cameraX: 0, cameraZ: 26, cameraY: 11 };
  }
  const perRing = 8;
  const step = (Math.PI * 2) / perRing;
  const offset = ring === 2 ? step / 2 : 0;
  const angle = slot * step + offset;
  const radius = RING_RADIUS[ring];
  const x = round(Math.cos(angle) * radius);
  const z = round(Math.sin(angle) * radius);
  // Stand back toward the atrium, above head height, looking slightly down.
  //
  // The distance is chosen so the room reads as a SPACE with its neighbours
  // around it rather than as a facade filling the frame. Successive browser
  // evidence screenshots settled it: at 17 units back the room was a wall of
  // colour, at 19 it still filled the frame. At 25 back and 13 up the room
  // occupies roughly a third of the frame with its neighbours either side,
  // which is what "large cinematic architectural space" actually looks like.
  //
  // Both rings stay in open floor at this offset: the inner ring's camera sits
  // at radius 5, out in the atrium plaza; the outer ring's sits at 29, and
  // because the outer ring is offset by half a slot, that line passes cleanly
  // BETWEEN two inner rooms — about 6 units of clearance either side — rather
  // than through one.
  const standOff = radius - 25;
  return {
    x,
    z,
    angle,
    cameraX: round(Math.cos(angle) * standOff),
    cameraZ: round(Math.sin(angle) * standOff),
    cameraY: 13,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Do two room volumes overlap?
 *
 * Used by the geometry test. A procedural layout is only trustworthy if
 * something checks it, and "no two rooms occupy the same space" is the one
 * property a reader would assume without being told.
 */
export function roomsOverlap(a: HqRoom, b: HqRoom): boolean {
  const anchorA = roomAnchor(a);
  const anchorB = roomAnchor(b);
  const span = ROOM_HALF_SPAN * 2;
  return Math.abs(anchorA.x - anchorB.x) < span && Math.abs(anchorA.z - anchorB.z) < span;
}
