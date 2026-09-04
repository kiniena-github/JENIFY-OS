/**
 * The seventeen approved HQ destinations (issue #250, Phase 2 Stage 4).
 *
 * The Founder approved a 17-screen HQ by name and order. This suite is what
 * makes that a property of the code rather than of somebody's memory: the
 * registry must hold exactly those seventeen, each reachable by a deterministic
 * route, each standing somewhere no other room stands, and each honest about
 * whether it is allowed to claim canonical state.
 */

import { describe, expect, it } from 'vitest';
import {
  HQ_ROOMS,
  ROOM_HALF_SPAN,
  liveRooms,
  roomAnchor,
  roomById,
  roomForRoute,
  roomRoute,
  roomsOverlap,
} from '../src/client/rooms.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Founder's list, in the Founder's order. Transcribed from issue #250. */
const APPROVED = [
  'Main Home',
  'Command Room',
  'Mission Room',
  'Meeting Room',
  'World Network',
  'Department Navigation',
  'AI Workforce',
  'Approvals',
  'Resources',
  'Analytics',
  'Founder Office',
  'Projects',
  'Product Factory',
  'Company Memory',
  'Research / R&D',
  'Security Center',
  'Settings / Connections',
];

describe('the room registry holds the seventeen approved destinations', () => {
  it('has exactly seventeen rooms, in the approved order', () => {
    expect(HQ_ROOMS).toHaveLength(17);
    expect(HQ_ROOMS.map((room) => room.name)).toEqual(APPROVED);
  });

  it('numbers them 1..17 with no gap and no repeat', () => {
    expect(HQ_ROOMS.map((room) => room.ordinal)).toEqual(
      Array.from({ length: 17 }, (_, index) => index + 1),
    );
  });

  it('gives every room a unique id and a deterministic route', () => {
    const ids = new Set(HQ_ROOMS.map((room) => room.id));
    expect(ids.size).toBe(17);
    for (const room of HQ_ROOMS) {
      expect(room.id).toMatch(/^[a-z0-9-]+$/);
      expect(roomRoute(room.id)).toBe(`#/room/${room.id}`);
      expect(roomForRoute(roomRoute(room.id))?.id).toBe(room.id);
      expect(roomById(room.id)).toBe(room);
    }
  });

  it('resolves an unknown or malformed route to null rather than to a near match', () => {
    // A spatial UI that silently substitutes a different room than the URL
    // named is lying about where the reader is standing.
    for (const hash of ['', '#', '#/room/', '#/room/does-not-exist', '#/rooms/home', '#/room/HOME', 'home']) {
      expect(roomForRoute(hash), hash).toBeNull();
    }
  });

  it('states a binding for every room, and a source for every live one', () => {
    for (const room of HQ_ROOMS) {
      expect(['live', 'not_recorded', 'later_phase']).toContain(room.binding.kind);
      if (room.binding.kind === 'live') {
        expect(room.binding.source.length, room.id).toBeGreaterThan(20);
        expect(room.binding.section.length, room.id).toBeGreaterThan(0);
      } else {
        // A room that claims nothing must still SAY something, at length: an
        // unexplained empty room is indistinguishable from a broken one.
        expect(room.binding.reason.length, room.id).toBeGreaterThan(80);
      }
    }
  });

  it('binds every room the issue names as a minimum-live room to canonical state', () => {
    // Issue #250 §C names these eight as the rooms that must be meaningfully
    // live rather than decorative. This is that requirement, asserted.
    const required = [
      'home',
      'command-room',
      'mission-room',
      'ai-workforce',
      'approvals',
      'departments',
      'analytics',
      'security-center',
    ];
    for (const id of required) {
      expect(roomById(id)?.binding.kind, id).toBe('live');
    }
  });

  it('reports the honest live/not-live split', () => {
    // Not a target to be gamed — a record of what today's canonical control
    // plane actually holds. Changing it means changing the bindings, which
    // means changing this line deliberately.
    expect(liveRooms().map((room) => room.id).sort()).toEqual(
      [
        'ai-workforce',
        'analytics',
        'approvals',
        'command-room',
        'connections',
        'departments',
        'founder-office',
        'home',
        'mission-room',
        'projects',
        'resources',
        'security-center',
        'world-network',
      ].sort(),
    );
    expect(HQ_ROOMS.filter((room) => room.binding.kind !== 'live').map((room) => room.id).sort()).toEqual(
      ['company-memory', 'meeting-room', 'product-factory', 'research'].sort(),
    );
  });

  it('links only to HQ pages that the site actually emits', () => {
    const emitted = new Set([
      'index.html',
      'immersive.html',
      'headquarters.html',
      'projects.html',
      'executive-room.html',
      'direct-chats.html',
      'specialists.html',
      'approvals.html',
      'connections.html',
      'archive.html',
    ]);
    for (const room of HQ_ROOMS) {
      if (room.page) expect(emitted.has(room.page), `${room.id} → ${room.page}`).toBe(true);
    }
  });
});

describe('the building is laid out by construction, and the construction is sound', () => {
  it('puts exactly one room in the atrium and eight in each ring', () => {
    const counts = { 0: 0, 1: 0, 2: 0 } as Record<number, number>;
    for (const room of HQ_ROOMS) counts[room.placement.ring] += 1;
    expect(counts).toEqual({ 0: 1, 1: 8, 2: 8 });
  });

  it('never places two rooms in the same space', () => {
    for (let i = 0; i < HQ_ROOMS.length; i += 1) {
      for (let j = i + 1; j < HQ_ROOMS.length; j += 1) {
        expect(
          roomsOverlap(HQ_ROOMS[i]!, HQ_ROOMS[j]!),
          `${HQ_ROOMS[i]!.id} overlaps ${HQ_ROOMS[j]!.id}`,
        ).toBe(false);
      }
    }
  });

  it('stands each room’s camera between the atrium and the room it looks at', () => {
    for (const room of HQ_ROOMS) {
      if (room.placement.ring === 0) continue;
      const anchor = roomAnchor(room);
      const roomRadius = Math.hypot(anchor.x, anchor.z);
      const cameraRadius = Math.hypot(anchor.cameraX, anchor.cameraZ);
      // Inside the room's ring — otherwise the camera would be looking at the
      // back of the building — and outside the room's own footprint.
      expect(cameraRadius, room.id).toBeLessThan(roomRadius);
      expect(roomRadius - cameraRadius, room.id).toBeGreaterThan(ROOM_HALF_SPAN);
    }
  });

  it('is reproducible: the same room always yields the same anchor', () => {
    for (const room of HQ_ROOMS) {
      expect(roomAnchor(room)).toEqual(roomAnchor(room));
    }
  });
});

describe('every declared section is actually bound to a room', () => {
  it('leaves no section unreachable', () => {
    // `activity` was declared as a RoomSection, implemented as a full
    // `activitySection`, and bound by NO room — so it never ran, and nothing
    // said so. It also carried the round-13 defect: it derived `attention` by
    // matching status strings against a set, on activity events whose status is
    // historical rather than a statement about now.
    //
    // Unreachable code with a plausible name is the next person's mistake
    // waiting to happen. This makes a dead section fail immediately rather than
    // sit there looking maintained.
    const bound = new Set(
      HQ_ROOMS.flatMap((room) => (room.binding.kind === 'live' ? [room.binding.section] : [])),
    );
    // Read the declared union straight from the source, so adding a member
    // without binding it is what fails — not a list in this test.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'rooms.ts'),
      'utf8',
    );
    const union = source.split('export type RoomSection')[1]!.split(';')[0]!;
    const declared = [...union.matchAll(/'(\w+)'/g)].map((match) => match[1]!);
    expect(declared.length).toBeGreaterThan(8);
    const unbound = declared.filter((section) => !(bound as Set<string>).has(section));
    expect(unbound, `declared but bound to no room: ${unbound.join(', ')}`).toEqual([]);
  });
});
