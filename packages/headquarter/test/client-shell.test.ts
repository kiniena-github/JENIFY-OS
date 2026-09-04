/**
 * The immersive shell: feature detection, motion policy, and the procedural
 * building (issue #250, Phase 2 Stage 4 §B).
 *
 * The detection and motion decisions are executed from the SHIPPED source, the
 * same pattern the freshness and grant rules use, so what is asserted here is
 * what a browser runs. The geometry is generated in Node, which is only
 * possible because the building is procedural: there is no asset to load, so
 * "is the floor plan sound" is a unit test rather than a screenshot review.
 */

import { describe, expect, it } from 'vitest';
import {
  MOTION_MODE_JS,
  WEBGL_SUPPORT_JS,
  LIVENESS_COLOR,
  buildSceneGeometry,
  immersiveShellScript,
} from '../src/client/webgl.js';
import { clientRuntimeScript } from '../src/client/runtime.js';
import { HQ_ROOMS, ROOM_HALF_SPAN, roomAnchor } from '../src/client/rooms.js';

const detectWebgl = new Function(`${WEBGL_SUPPORT_JS}; return detectWebgl;`)() as (
  canvas: unknown,
) => { ok: boolean; gl?: unknown; reason: string };

const motionMode = new Function(`${MOTION_MODE_JS}; return motionMode;`)() as (
  explicit: string | null,
  mediaMatches: boolean,
) => { reduced: boolean; source: string };

function fakeCanvas(behaviour: Record<string, unknown>): unknown {
  return {
    getContext(name: string) {
      const value = behaviour[name];
      if (value === 'throw') throw new Error('blocked by privacy mode');
      return value ?? null;
    },
  };
}

describe('WebGL detection admits a working context and nothing else', () => {
  it('prefers WebGL 2 when the device offers it', () => {
    const gl2 = { isContextLost: () => false, tag: 'webgl2' };
    const result = detectWebgl(fakeCanvas({ webgl2: gl2, webgl: { tag: 'webgl1' } }));
    expect(result.ok).toBe(true);
    expect(result.gl).toBe(gl2);
  });

  it('falls back through webgl and experimental-webgl', () => {
    const gl1 = { tag: 'webgl1' };
    expect(detectWebgl(fakeCanvas({ webgl: gl1 })).gl).toBe(gl1);
    const experimental = { tag: 'experimental' };
    expect(detectWebgl(fakeCanvas({ 'experimental-webgl': experimental })).gl).toBe(experimental);
  });

  it('treats a throwing getContext as no WebGL, not as a crash', () => {
    // Some privacy modes throw rather than returning null. A page that let that
    // escape would show a black rectangle where a building should be.
    const result = detectWebgl(fakeCanvas({ webgl2: 'throw', webgl: 'throw', 'experimental-webgl': 'throw' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not provide WebGL');
  });

  it('refuses a context that reports itself already lost', () => {
    const result = detectWebgl(fakeCanvas({ webgl2: { isContextLost: () => true } }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('lost');
    expect(result.reason).toContain('rooms below are unaffected');
  });

  it('refuses anything that is not a canvas at all', () => {
    for (const value of [null, undefined, {}, 'canvas', 7]) {
      expect(detectWebgl(value).ok, String(value)).toBe(false);
    }
  });

  it('always explains itself when it refuses', () => {
    const result = detectWebgl(null);
    expect(result.reason.length).toBeGreaterThan(40);
  });
});

describe('the motion policy respects an explicit choice in both directions', () => {
  it('honours reduced motion asked for by the system', () => {
    const result = motionMode(null, true);
    expect(result.reduced).toBe(true);
    expect(result.source).toContain('system');
  });

  it('lets a reader turn motion ON over their system default', () => {
    // Second-guessing an explicit choice is its own accessibility failure.
    expect(motionMode('full', true).reduced).toBe(false);
    expect(motionMode('full', true).source).toContain('You chose');
  });

  it('lets a reader turn motion OFF where the system asked for none', () => {
    expect(motionMode('reduced', false).reduced).toBe(true);
  });

  it('defaults to full motion only when nothing asked otherwise', () => {
    expect(motionMode(null, false).reduced).toBe(false);
    // An unrecognised stored value must not be read as a choice.
    expect(motionMode('maybe', true).reduced).toBe(true);
    expect(motionMode('maybe', false).reduced).toBe(false);
  });
});

describe('the building is generated from code, with nothing to load', () => {
  const geometry = buildSceneGeometry();

  it('produces a whole number of triangles', () => {
    expect(geometry.vertices.length % 11).toBe(0);
    expect(Number.isInteger(geometry.triangles)).toBe(true);
    expect(geometry.triangles).toBeGreaterThan(100);
  });

  it('stays small enough to be a buffer upload rather than a download', () => {
    // A procedural building of boxes and panels. If this ever needs thousands
    // of triangles, the design has changed and this line should be the thing
    // that says so.
    expect(geometry.triangles).toBeLessThan(2000);
  });

  it('is byte-identical between builds', () => {
    expect(buildSceneGeometry().vertices).toEqual(geometry.vertices);
  });

  it('gives every ring room a slot the shader can index, and gives the structure slot 0', () => {
    const slots = new Set<number>();
    for (let i = 0; i < geometry.vertices.length; i += 11) slots.add(geometry.vertices[i + 9]!);
    expect(slots.has(0)).toBe(true);
    for (const room of HQ_ROOMS) {
      if (room.placement.ring === 0) continue;
      expect(slots.has(room.ordinal), room.id).toBe(true);
    }
    // Slot 0 is the structure and 1..17 are the rooms. The shell's per-slot
    // state array is sized to that, so a slot outside the range would read past
    // the end of it when the lighting buffer is filled.
    for (const slot of slots) {
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThanOrEqual(17);
    }
  });

  it('keeps every room’s geometry inside that room’s own footprint', () => {
    // Checked in the room's OWN frame, which is the frame it was designed in.
    // An earlier version of the building was an axis-aligned box with a rotated
    // facade bolted on, and for the diagonal rooms that put the glass wall
    // outside the room it belonged to — a defect a world-space bounding box
    // reports as a mystery number and a local-space check names exactly.
    const inverse = (room: (typeof HQ_ROOMS)[number]) => {
      const anchor = roomAnchor(room);
      const cos = Math.cos(anchor.angle);
      const sin = Math.sin(anchor.angle);
      return (x: number, z: number): [number, number] => {
        const dx = x - anchor.x;
        const dz = z - anchor.z;
        return [dx * cos + dz * sin, -dx * sin + dz * cos];
      };
    };
    for (const room of HQ_ROOMS) {
      if (room.placement.ring === 0) continue;
      const toLocal = inverse(room);
      let found = false;
      for (let i = 0; i < geometry.vertices.length; i += 11) {
        if (geometry.vertices[i + 9]! !== room.ordinal) continue;
        found = true;
        const [lx, lz] = toLocal(geometry.vertices[i]!, geometry.vertices[i + 2]!);
        // The facade sits 0.12 outside the frontage wall, deliberately, so it
        // reads as glass set into a frame rather than as the wall itself.
        expect(Math.abs(lx), `${room.id} depth`).toBeLessThanOrEqual(ROOM_HALF_SPAN + 0.15);
        expect(Math.abs(lz), `${room.id} frontage`).toBeLessThanOrEqual(ROOM_HALF_SPAN + 0.001);
      }
      expect(found, `${room.id} contributed no geometry`).toBe(true);
    }
  });

  it('winds every triangle so its geometric normal agrees with its supplied one', () => {
    // The invariant that back-face culling actually depends on, checked over
    // EVERY triangle rather than face by face.
    //
    // The top faces were wound the other way, giving a geometric normal of -Y
    // against a supplied +Y, so with `cullFace(BACK)` every roof and the atrium
    // floor were removed the moment the camera was above them. The building
    // rendered roofless and groundless, and I read the resulting murk as a
    // lighting problem and spent two rounds adjusting the shader. A cross
    // product would have said it immediately (Codex round 2).
    for (let i = 0; i < geometry.vertices.length; i += 11 * 3) {
      const at = (v: number, o: number) => geometry.vertices[i + v * 11 + o]!;
      const p = [0, 1, 2].map((v) => [at(v, 0), at(v, 1), at(v, 2)]);
      const supplied = [at(0, 3), at(0, 4), at(0, 5)];
      const e1 = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!];
      const e2 = [p[2]![0]! - p[1]![0]!, p[2]![1]! - p[1]![1]!, p[2]![2]! - p[1]![2]!];
      const geometric = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      const length = Math.hypot(...geometric);
      expect(length, `degenerate triangle at vertex ${i / 11}`).toBeGreaterThan(1e-6);
      const dot =
        (geometric[0]! * supplied[0]! + geometric[1]! * supplied[1]! + geometric[2]! * supplied[2]!) / length;
      // Same direction, not merely the same axis: a sign flip IS the bug.
      expect(dot, `triangle at vertex ${i / 11} is wound against its normal`).toBeGreaterThan(0.9);
    }
  });

  it('gives Main Home geometry of its own, so the atrium can be lit by its state', () => {
    // The atrium used to be emitted as structural slot 0, which meant ordinal 1
    // had no vertices at all: hydration computed Main Home's liveness, wrote it
    // to slot 1, and nothing in the building could ever read it — while the
    // page promised all seventeen rooms were state-lit (Codex round 2).
    const home = HQ_ROOMS.find((room) => room.placement.ring === 0)!;
    let vertices = 0;
    for (let i = 0; i < geometry.vertices.length; i += 11) {
      if (geometry.vertices[i + 9] === home.ordinal) vertices += 1;
    }
    expect(vertices, 'Main Home has no geometry bound to its slot').toBeGreaterThan(0);
  });

  it('gives every one of the seventeen rooms geometry the shell can light', () => {
    const slots = new Set<number>();
    for (let i = 0; i < geometry.vertices.length; i += 11) slots.add(geometry.vertices[i + 9]!);
    for (const room of HQ_ROOMS) {
      expect(slots.has(room.ordinal), `${room.id} (ordinal ${room.ordinal}) has no geometry`).toBe(true);
    }
  });

  it('never puts geometry below the floor', () => {
    for (let i = 0; i < geometry.vertices.length; i += 11) {
      expect(geometry.vertices[i + 1]!).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the shell can only be lit by the hydration runtime', () => {
  const script = immersiveShellScript();

  it('takes no data of its own — the emitted room list carries geometry and names only', () => {
    // Every state word must be ABSENT from the shell's baked-in room data. If a
    // liveness ever travelled with the geometry, the shell could light a room
    // the state document did not.
    const roomsLiteral = /var ROOMS = (\[.*?\]);\n/s.exec(script)?.[1];
    expect(roomsLiteral).toBeTruthy();
    const parsed = JSON.parse(roomsLiteral!) as Record<string, unknown>[];
    expect(parsed).toHaveLength(17);
    for (const room of parsed) {
      expect(Object.keys(room).sort()).toEqual(['camX', 'camY', 'camZ', 'id', 'name', 'ordinal', 'x', 'z']);
    }
  });

  it('exposes exactly one entry point for state, and one for navigation', () => {
    expect(script).toContain('window.__hqShellApply =');
    expect(script).toContain('window.__hqShellGoTo = goTo');
  });

  it('pulses only the two liveness values that mean live work, and never under reduced motion', () => {
    expect(script).toContain(
      "var pulsing = (!motion.reduced && (view.liveness === 'active' || view.liveness === 'attention')) ? 1 : 0;",
    );
    // A dark room keeps a trace of light so its architecture reads, and no more.
    expect(script).toContain(": 0.06;");
  });

  it('freezes the shader clock and stops the loop under reduced motion', () => {
    expect(script).toContain('gl.uniform1f(uTime, motion.reduced ? 0 : t);');
    expect(script).toContain('var ease = motion.reduced ? 1 : 0.085;');
    expect(script).toContain('if (idleFrames > 3) { running = false; return; }');
  });

  it('indexes no uniform array by a value the vertex data supplies', () => {
    // GLSL ES 1.00 only REQUIRES array indexing by a constant-index-expression
    // (Appendix A). A room slot read out of a vertex attribute is not one, so a
    // strict WebGL 1 implementation may legally refuse to compile it — and the
    // failure mode is the whole building silently missing on exactly the
    // devices least likely to be tested. Per-room lighting therefore travels as
    // a vertex attribute rewritten on state change, and this test is what stops
    // the tempting uniform-array shape coming back.
    expect(script).not.toMatch(/uniform\s+\w+\s+\w+\s*\[/);
    expect(script).toContain('attribute vec4 aState;');
    expect(script).toContain('attribute vec2 aPulse;');
    expect(script).toContain('gl.bufferSubData(gl.ARRAY_BUFFER, 0, stateData)');
  });

  it('recomputes the building when the motion preference changes', () => {
    // Codex round 10. The motion preference is an INPUT to the per-room pulse
    // flags and to `anyMotion`, and `applyViews` is the only place either is
    // computed — but both motion handlers changed the policy and called
    // `wake()`, which redraws with the OLD flags. Reduced → full left active and
    // attention rooms frozen until the next poll up to twenty seconds later;
    // full → reduced left `anyMotion` true, so the loop went on scheduling
    // frames forever against a deliberately frozen shader clock. That second
    // one also made this module's own docstring false where it promises the
    // render loop stops itself under reduced motion.
    //
    // Structural, because CI has no GPU: what is pinned is that neither handler
    // can go back to a bare `wake()`, and that the shell keeps the state needed
    // to recompute.
    expect(script).toContain('var lastViews = null;');
    expect(script).toContain('function reapplyMotion() {');
    expect(script).toContain('if (lastViews) applyViews(lastViews, lastActiveRoom);');
    // Both handlers — the button and the OS media query — go through it.
    expect(script.match(/reapplyMotion\(\);/g) ?? []).toHaveLength(2);
    // And the entry point still records what it was given, or reapply would
    // have nothing to recompute from.
    expect(script).toContain('lastViews = views;');
    expect(script).toContain('lastActiveRoom = activeRoomId;');
  });

  it('shuts every entry point after the context is lost, not just the render loop', () => {
    // Codex round 5. The runtime holds its own references to __hqShellApply and
    // __hqShellGoTo and calls them on every poll and every hash change, so
    // stopping the loop was not enough: the next successful poll ran buffer
    // operations against a lost context and then called wake(), and because a
    // lit room sets anyMotion the loop then ran forever against a canvas no
    // longer in the document.
    //
    // This is a STRUCTURAL check — CI has no GPU and no way to lose a context.
    // The behavioural proof is `tools/webgl-evidence.mjs`, which loses the
    // context for real and then counts animation frames.
    expect(script).toContain('var disposed = false;');
    // Set before anything else in the handler, so nothing can re-enter first.
    expect(script).toMatch(/event\.preventDefault\(\);[\s\S]{0,800}?disposed = true;\s*\n\s*running = false;/);
    for (const guard of [
      'function wake() {\n    if (disposed) return;',
      'function tick(now) {\n    if (disposed) { running = false; return; }',
      'window.__hqShellApply = function (views, activeRoomId) {\n    if (disposed) return;',
      'function goTo(roomId) {\n    if (disposed) return;',
    ]) {
      expect(script, `missing disposal guard: ${guard.split('\n')[0]}`).toContain(guard);
    }
  });

  it('caps the device pixel ratio so a high-DPI screen cannot melt the GPU', () => {
    expect(script).toContain('Math.min(window.devicePixelRatio || 1, 2)');
  });

  it('names a colour for every liveness the hydration layer can produce', () => {
    expect(Object.keys(LIVENESS_COLOR).sort()).toEqual(['active', 'attention', 'dark', 'quiet']);
    for (const channels of Object.values(LIVENESS_COLOR)) {
      expect(channels).toHaveLength(3);
      for (const channel of channels) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('stays within a page budget that needed no lazy loading', () => {
    // Issue #250 asks for a lightweight initial path and lazy 3D "if needed".
    // It is not needed: with no library and quantised procedural geometry the
    // whole shell — shaders, renderer, building and all — is smaller than a
    // single 3D library's minified core, so splitting it would add a request
    // and a loading state to save nothing. This line is what keeps that true:
    // if the shell ever outgrows it, lazy loading becomes the right answer and
    // this test is where that conversation starts.
    expect(Buffer.byteLength(script, 'utf8')).toBeLessThan(140_000);
  });

  it('quantises its geometry, so the page is reproducible and not needlessly large', () => {
    const roomsLiteral = /var VERTS = (\[.*?\]);\n/s.exec(script)?.[1];
    expect(roomsLiteral).toBeTruthy();
    for (const value of JSON.parse(roomsLiteral!) as number[]) {
      const decimals = String(value).split('.')[1]?.length ?? 0;
      expect(decimals, String(value)).toBeLessThanOrEqual(3);
    }
    expect(script).not.toContain('-0,');
  });

  it('emits JavaScript that actually parses', () => {
    // Guard against a whole class of defect this package is unusually exposed
    // to: browser source lives inside TypeScript template literals, so a
    // stray backtick in a CODE COMMENT silently terminates the literal. `tsc`
    // catches it as a TypeScript syntax error, but only if someone runs `tsc`
    // between writing the comment and shipping — and the failure it produces
    // points at a line that looks fine. Parsing every emitted script here makes
    // the check part of the suite instead of part of anyone's discipline.
    for (const [name, source] of [
      ['shell', immersiveShellScript()],
      ['runtime', clientRuntimeScript()],
    ] as const) {
      const bodies = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
      expect(bodies.length, name).toBeGreaterThan(0);
      for (const body of bodies) {
        // `new Function` parses without executing. A syntax error throws here.
        expect(() => new Function(body), name).not.toThrow();
      }
    }
  });

  it('loads no external resource of any kind', () => {
    // The whole reason this shell is written against WebGL directly rather than
    // against a library: a page that renders canonical company state pulls in
    // nothing it did not ship with.
    expect(script).not.toContain('http://');
    expect(script).not.toContain('https://');
    expect(script).not.toContain('import(');
    expect(script).not.toContain('importScripts');
    expect(script).not.toContain('createElement(\'script\')');
  });
});
