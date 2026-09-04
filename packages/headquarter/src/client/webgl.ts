/**
 * The immersive 3D HQ shell (issue #250, Stage 4 §B).
 *
 * ## Why raw WebGL and not Three.js
 *
 * The issue names Three.js / React Three Fiber as an example, not a
 * requirement, and this repository's HQ surface is emitted as static HTML by
 * `build-site.ts`: there is no bundler in `@factoryos/headquarter`, and the
 * pages are served from HQ's own Founder-gated origin. Reaching for Three.js
 * would have meant one of two things, and both are worse:
 *
 *   - a CDN `<script>` — an untracked external asset on a page that renders
 *     canonical company state, which the issue explicitly rules out
 *     ("reproducible from code and does not depend on untracked external
 *     assets"), and a third-party origin on the one document that must stay
 *     same-origin for its session cookie to work at all;
 *   - a new bundler and build step in a package whose whole architecture is
 *     "pure functions from data to HTML, testable with no server".
 *
 * The building here is procedural — boxes, a floor grid, light columns and
 * glass facades — which is a few hundred triangles and needs none of a scene
 * graph's features. So the shell is written directly against WebGL, ships with
 * the page, adds zero dependencies and zero supply chain, and stays inside the
 * bundle budget by construction. If a later phase needs skinned meshes, glTF
 * or post-processing stacks, that is the point to take the dependency.
 *
 * ## What the shell may and may not show
 *
 * A room's light is `hydrate.ts`'s `RoomLiveness` and nothing else. There is no
 * ambient "something is happening" animation, no idle worker walking a
 * corridor, no counter ticking up. A dark room is a room canonical state says
 * is empty, and it stays dark. The one time-based motion in the scene is a slow
 * breathing pulse on rooms whose liveness is `active` or `attention`, and a
 * lazy drift of the atrium light — neither of which asserts anything.
 *
 * ## Three ways in, all of them complete
 *
 *   1. **WebGL available, motion allowed** — the full shell, camera flights
 *      between rooms.
 *   2. **WebGL available, reduced motion** — the same shell, but every camera
 *      move is an instant cut and every pulse is frozen at its rest value. The
 *      render loop then stops itself, so an idle tab costs no GPU at all.
 *   3. **No WebGL** — the canvas is removed and the page is exactly the
 *      server-rendered document: all seventeen rooms, every metric, every row.
 *      Nothing is lost but the picture, because the picture was never the only
 *      copy of the information.
 */

import { jsonForScript } from '../ui/components.js';
import { HQ_ROOMS, ROOM_HALF_SPAN, roomAnchor } from './rooms.js';

/**
 * Feature detection, as browser-executable source.
 *
 * Strict on purpose. A context that reports itself lost immediately, or a
 * `getContext` that throws (some privacy modes do), or a driver that refuses
 * both context names, all resolve to "no WebGL" and the page takes route 3
 * above. The one thing this must never do is half-start: a canvas that
 * initialised and then failed would leave the reader looking at a black
 * rectangle where a building should be, with no explanation.
 */
export const WEBGL_SUPPORT_JS = `function detectWebgl(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return { ok: false, reason: 'This browser exposes no canvas element, so the 3D headquarters cannot be drawn.' };
  }
  var attrs = { alpha: false, antialias: true, depth: true, powerPreference: 'default', failIfMajorPerformanceCaveat: false };
  var gl = null;
  try { gl = canvas.getContext('webgl2', attrs); } catch (e) { gl = null; }
  if (!gl) { try { gl = canvas.getContext('webgl', attrs); } catch (e2) { gl = null; } }
  if (!gl) { try { gl = canvas.getContext('experimental-webgl', attrs); } catch (e3) { gl = null; } }
  if (!gl) {
    return { ok: false, reason: 'This browser or device does not provide WebGL, so the 3D headquarters cannot be drawn. Every room and every figure below is the same data the 3D view would have shown.' };
  }
  if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
    return { ok: false, reason: 'The graphics context was lost immediately after it was created, so the 3D headquarters is not drawn. The rooms below are unaffected.' };
  }
  return { ok: true, gl: gl, reason: '' };
}`;

/**
 * The motion policy, as browser-executable source.
 *
 * Three inputs, in precedence order: an explicit choice the reader made on
 * this page, then the OS-level `prefers-reduced-motion`, then full motion. The
 * explicit choice wins in BOTH directions — a reader who turns motion on has
 * overridden their OS default deliberately, and second-guessing that would be
 * its own accessibility failure.
 */
export const MOTION_MODE_JS = `function motionMode(explicit, mediaMatches) {
  if (explicit === 'reduced') return { reduced: true, source: 'You chose reduced motion for this page.' };
  if (explicit === 'full') return { reduced: false, source: 'You chose full motion for this page.' };
  if (mediaMatches === true) return { reduced: true, source: 'Your system asks for reduced motion, so camera moves are instant cuts.' };
  return { reduced: false, source: 'Full motion. Camera moves ease between rooms.' };
}`;

/** Colour per liveness, as linear RGB. Kept beside the CSS tones on purpose. */
export const LIVENESS_COLOR: Record<string, [number, number, number]> = {
  active: [0.16, 0.74, 0.96],
  attention: [0.98, 0.66, 0.19],
  quiet: [0.32, 0.42, 0.55],
  dark: [0.13, 0.16, 0.21],
};

/**
 * The scene's static geometry, generated at build time.
 *
 * Emitting the vertex data as a literal rather than building it in the browser
 * keeps the shell's startup cost to a buffer upload, makes the building
 * byte-identical across builds (so a diff in the page is a real change), and
 * means the geometry can be asserted in a Node test without a canvas.
 *
 * Layout per vertex: px py pz nx ny nz r g b roomSlot emissive  (11 floats)
 * `roomSlot` is 0 for the structure and 1..17 for a room, so the shader can
 * index its per-room uniform array without a branch per triangle.
 */
export interface SceneGeometry {
  vertices: number[];
  /** Triangle count, for the test that guards the budget. */
  triangles: number;
}

/**
 * Quantise to a millimetre of a world unit.
 *
 * The building is tens of units across, so three decimals is far beyond what
 * any pixel can resolve — and it matters for a real reason rather than a
 * tidiness one: the room rotations produce full-precision doubles, and
 * serialising ~13,000 of them at 17 significant figures added roughly 60 kB to
 * a page that renders canonical company state. Rounding here also makes the
 * emitted geometry byte-identical across platforms, which is what lets a diff
 * in the page mean a real change.
 */
function q(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  // Normalise -0 to 0, so the same corner never serialises two ways.
  return rounded === 0 ? 0 : rounded;
}

function pushQuad(
  out: number[],
  corners: [number, number, number][],
  normal: [number, number, number],
  color: [number, number, number],
  slot: number,
  emissive: number,
): void {
  const [a, b, c, d] = corners;
  for (const point of [a, b, c, a, c, d]) {
    out.push(
      q(point[0]), q(point[1]), q(point[2]),
      q(normal[0]), q(normal[1]), q(normal[2]),
      color[0], color[1], color[2],
      slot, emissive,
    );
  }
}

/**
 * A room's local frame.
 *
 * Every room is built in its OWN coordinates and rotated into place, rather
 * than being an axis-aligned box with a rotated panel bolted to the front. That
 * matters: with an axis-aligned shell, a diagonal room's glass facade hung at
 * an angle across the corner of its own box — geometrically outside the room it
 * belonged to. Building the whole room in local space and rotating it makes
 * "the facade is the wall facing the atrium" true by construction, and lets the
 * geometry test check containment in the frame the room was designed in.
 *
 * Local +X points AWAY from the atrium (so the facade is at local −X), local +Z
 * runs across the room's frontage, and local +Y is up as usual.
 */
export interface RoomFrame {
  /** Local (x, z) → world (x, z). */
  toWorld(lx: number, lz: number): [number, number];
  /** Local (x, z) direction → world direction. Rotation only, no translation. */
  rotate(lx: number, lz: number): [number, number];
}

export function roomFrame(cx: number, cz: number, angle: number): RoomFrame {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    toWorld: (lx, lz) => [cx + lx * cos - lz * sin, cz + lx * sin + lz * cos],
    rotate: (lx, lz) => [lx * cos - lz * sin, lx * sin + lz * cos],
  };
}

/** A box in a room's local frame; five faces (no underside — never visible). */
function pushBox(
  out: number[],
  frame: RoomFrame,
  halfX: number,
  halfZ: number,
  height: number,
  base: number,
  color: [number, number, number],
  slot: number,
): void {
  const y0 = base;
  const y1 = base + height;
  const corner = (lx: number, lz: number, y: number): [number, number, number] => {
    const [x, z] = frame.toWorld(lx, lz);
    return [x, y, z];
  };
  const normal = (lx: number, lz: number): [number, number, number] => {
    const [x, z] = frame.rotate(lx, lz);
    return [x, 0, z];
  };
  const [a, b] = [-halfX, halfX];
  const [c, d] = [-halfZ, halfZ];
  // Top.
  pushQuad(out, [corner(a, c, y1), corner(b, c, y1), corner(b, d, y1), corner(a, d, y1)], [0, 1, 0], color, slot, 0);
  // +Z side.
  pushQuad(out, [corner(a, d, y0), corner(b, d, y0), corner(b, d, y1), corner(a, d, y1)], normal(0, 1), color, slot, 0);
  // −Z side.
  pushQuad(out, [corner(b, c, y0), corner(a, c, y0), corner(a, c, y1), corner(b, c, y1)], normal(0, -1), color, slot, 0);
  // +X side (the back, away from the atrium).
  pushQuad(out, [corner(b, d, y0), corner(b, c, y0), corner(b, c, y1), corner(b, d, y1)], normal(1, 0), color, slot, 0);
  // −X side (the frontage the facade sits on).
  pushQuad(out, [corner(a, c, y0), corner(a, d, y0), corner(a, d, y1), corner(a, c, y1)], normal(-1, 0), color, slot, 0);
}

/**
 * The whole building.
 *
 * A dark metal plinth per room, a glass facade panel facing the atrium, a light
 * column behind it, plus the atrium floor and its ring. The facade and the
 * column are the EMISSIVE parts — those are what the per-room liveness uniform
 * lights, so a dark room still has its architecture and simply is not lit.
 */
export function buildSceneGeometry(): SceneGeometry {
  const out: number[] = [];
  const shell: [number, number, number] = [0.08, 0.1, 0.13];
  const metal: [number, number, number] = [0.12, 0.145, 0.185];

  // Atrium floor: one large slab, plus a raised ring the rooms look onto.
  pushQuad(
    out,
    [[-80, 0, -80], [80, 0, -80], [80, 0, 80], [-80, 0, 80]],
    [0, 1, 0],
    [0.045, 0.055, 0.075],
    0,
    0,
  );
  pushBox(out, roomFrame(0, 0, 0), 9, 9, 0.6, 0, metal, 0);
  // Four atrium light blades — structure, never a state claim.
  for (const [bx, bz] of [[0, 12], [0, -12], [12, 0], [-12, 0]] as const) {
    pushBox(out, roomFrame(bx, bz, 0), 0.35, 0.35, 16, 0, [0.1, 0.3, 0.42], 0);
  }

  for (const room of HQ_ROOMS) {
    if (room.placement.ring === 0) continue;
    const anchor = roomAnchor(room);
    const frame = roomFrame(anchor.x, anchor.z, anchor.angle);
    const slot = room.ordinal;
    const half = ROOM_HALF_SPAN;
    // The volume of the room, built facing the atrium.
    pushBox(out, frame, half, half, 9, 0, shell, slot);
    // Facade: a glass panel on the atrium-facing wall, inset a little so the
    // shell reads as a frame around it. In the room's own frame that is simply
    // "just outside local −X", with no trigonometry to get wrong.
    const facadeX = -(half + 0.12);
    const w = half * 0.82;
    const y0 = 1.1;
    const y1 = 7.4;
    const at = (lz: number, y: number): [number, number, number] => {
      const [x, z] = frame.toWorld(facadeX, lz);
      return [x, y, z];
    };
    const [nx, nz] = frame.rotate(-1, 0);
    pushQuad(out, [at(-w, y0), at(w, y0), at(w, y1), at(-w, y1)], [nx, 0, nz], [0.2, 0.5, 0.62], slot, 1);
    // Light column at the room's heart — the part that reads from across the
    // atrium when a room needs attention.
    pushBox(out, roomFrame(anchor.x, anchor.z, anchor.angle), 0.5, 0.5, 13.5, 0, [0.18, 0.55, 0.7], slot);
  }

  return { vertices: out, triangles: out.length / 11 / 3 };
}

/** The GLSL pair. GLSL ES 1.00, so one source runs on both WebGL 1 and 2. */
const VERTEX_SHADER = `
precision highp float;
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec2 aMeta;
uniform mat4 uViewProj;
uniform vec4 uRoom[18];
uniform vec3 uRoomTint[18];
uniform float uTime;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vTint;
varying float vEmissive;
varying float vGlow;
void main() {
  int slot = int(aMeta.x + 0.5);
  vec4 room = uRoom[slot];
  float pulse = room.y > 0.0 ? (0.72 + 0.28 * sin(uTime * 1.7 + float(slot))) : 1.0;
  vGlow = room.x * pulse + room.z * 0.45;
  vTint = uRoomTint[slot];
  vNormal = aNormal;
  vColor = aColor;
  vWorld = aPos;
  vEmissive = aMeta.y;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vTint;
varying float vEmissive;
varying float vGlow;
uniform vec3 uEye;
uniform vec3 uKey;
void main() {
  vec3 n = normalize(vNormal);
  vec3 toEye = normalize(uEye - vWorld);
  float lambert = max(dot(n, normalize(uKey)), 0.0);
  float rim = pow(1.0 - max(dot(n, toEye), 0.0), 3.0);
  vec3 base = vColor * (0.22 + 0.78 * lambert);
  vec3 lit = base + vColor * rim * 0.85;
  vec3 glow = vTint * vGlow * (vEmissive > 0.5 ? 2.35 : 0.85);
  vec3 color = lit + glow;
  // A floor grid drawn in the shader, so no extra geometry carries it.
  if (abs(n.y - 1.0) < 0.01 && vWorld.y < 0.05) {
    vec2 g = abs(fract(vWorld.xz / 4.0) - 0.5);
    float line = smoothstep(0.48, 0.5, max(g.x, g.y));
    color += vec3(0.05, 0.13, 0.18) * line;
  }
  float dist = length(uEye - vWorld);
  float fog = clamp((dist - 34.0) / 96.0, 0.0, 0.92);
  color = mix(color, vec3(0.016, 0.024, 0.037), fog);
  gl_FragColor = vec4(color, 1.0);
}`;

/**
 * The shell's browser source.
 *
 * `roomsJson` carries only id, ordinal, name and geometry — never state. State
 * arrives from the hydration runtime through `window.__hqShellApply`, so the
 * shell literally cannot light a room the state document did not light.
 */
export function immersiveShellScript(): string {
  const geometry = buildSceneGeometry();
  const rooms = HQ_ROOMS.map((room) => {
    const anchor = roomAnchor(room);
    return {
      id: room.id,
      ordinal: room.ordinal,
      name: room.name,
      x: anchor.x,
      z: anchor.z,
      camX: anchor.cameraX,
      camZ: anchor.cameraZ,
      camY: anchor.cameraY,
    };
  });

  return `<script>
(function () {
  var canvas = document.querySelector('[data-hq-canvas]');
  var status = document.querySelector('[data-hq-3d-status]');
  var labelLayer = document.querySelector('[data-hq-labels]');
  var bar = document.querySelector('[data-hq-building-bar]');
  var motionButton = null;
  var motionNote = null;
  if (!canvas) return;

  var ROOMS = ${jsonForScript(rooms)};
  var VERTS = ${jsonForScript(geometry.vertices)};
  var LIVENESS_COLOR = ${jsonForScript(LIVENESS_COLOR)};

  ${WEBGL_SUPPORT_JS}
  ${MOTION_MODE_JS}

  function say(text, tone) {
    if (!status) return;
    status.textContent = text;
    status.setAttribute('data-tone', tone);
  }

  var support = detectWebgl(canvas);
  if (!support.ok) {
    // Route 3. Remove the canvas entirely rather than leaving a black box:
    // the document below already carries every room in full.
    canvas.parentNode && canvas.parentNode.removeChild(canvas);
    if (labelLayer && labelLayer.parentNode) labelLayer.parentNode.removeChild(labelLayer);
    document.documentElement.setAttribute('data-hq-3d', 'unavailable');
    say(support.reason, 'warn');
    return;
  }
  var gl = support.gl;
  document.documentElement.setAttribute('data-hq-3d', 'on');

  // The motion toggle is created HERE, never rendered into the static page.
  // Two reasons, and both matter: the site-wide invariant is that the emitted
  // HTML carries no button at all, and a motion control on a page with no
  // camera would control nothing.
  if (bar) {
    motionButton = document.createElement('button');
    motionButton.type = 'button';
    motionButton.className = 'hq-motion';
    motionButton.setAttribute('data-hq-motion', '');
    motionButton.setAttribute('aria-pressed', 'false');
    motionButton.textContent = 'Motion: full';
    motionNote = document.createElement('span');
    motionNote.className = 'faint';
    bar.appendChild(motionButton);
    bar.appendChild(motionNote);
  }

  /* ---------- motion policy ---------- */
  var explicitMotion = null;
  try { explicitMotion = window.localStorage.getItem('hq.motion'); } catch (e) { explicitMotion = null; }
  var media = null;
  try { media = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e2) { media = null; }
  var motion = motionMode(explicitMotion, media ? media.matches === true : false);
  function applyMotionNote() {
    if (motionNote) motionNote.textContent = motion.source;
    if (motionButton) {
      motionButton.textContent = motion.reduced ? 'Motion: reduced' : 'Motion: full';
      motionButton.setAttribute('aria-pressed', motion.reduced ? 'true' : 'false');
    }
  }
  applyMotionNote();
  if (motionButton) {
    motionButton.addEventListener('click', function () {
      var next = motion.reduced ? 'full' : 'reduced';
      try { window.localStorage.setItem('hq.motion', next); } catch (e3) {}
      // Record the choice locally too, or the OS-preference listener below
      // would later re-derive from a stale null and silently undo it.
      explicitMotion = next;
      motion = motionMode(next, media ? media.matches === true : false);
      applyMotionNote();
      wake();
    });
  }
  if (media && typeof media.addEventListener === 'function') {
    media.addEventListener('change', function () {
      motion = motionMode(explicitMotion, media.matches === true);
      applyMotionNote();
      wake();
    });
  }

  /* ---------- program ---------- */
  function compile(type, src) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      return null;
    }
    return shader;
  }
  var vs = compile(gl.VERTEX_SHADER, ${jsonForScript(VERTEX_SHADER)});
  var fs = compile(gl.FRAGMENT_SHADER, ${jsonForScript(FRAGMENT_SHADER)});
  var program = vs && fs ? gl.createProgram() : null;
  if (program) {
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) program = null;
  }
  if (!program) {
    // A driver that accepted the context and refused the program. Same honest
    // outcome as no WebGL at all — never a black rectangle.
    canvas.parentNode && canvas.parentNode.removeChild(canvas);
    if (labelLayer && labelLayer.parentNode) labelLayer.parentNode.removeChild(labelLayer);
    if (motionButton && motionButton.parentNode) motionButton.parentNode.removeChild(motionButton);
    if (motionNote && motionNote.parentNode) motionNote.parentNode.removeChild(motionNote);
    document.documentElement.setAttribute('data-hq-3d', 'unavailable');
    say('This device accepted a graphics context but refused to compile the headquarters shaders, so the 3D view is not drawn. Every room below is unaffected.', 'warn');
    return;
  }
  gl.useProgram(program);

  var buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(VERTS), gl.STATIC_DRAW);
  var stride = 11 * 4;
  function attrib(name, size, offset) {
    var loc = gl.getAttribLocation(program, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  }
  attrib('aPos', 3, 0); attrib('aNormal', 3, 12); attrib('aColor', 3, 24); attrib('aMeta', 2, 36);
  var vertexCount = VERTS.length / 11;

  var uViewProj = gl.getUniformLocation(program, 'uViewProj');
  var uRoom = gl.getUniformLocation(program, 'uRoom');
  var uRoomTint = gl.getUniformLocation(program, 'uRoomTint');
  var uTime = gl.getUniformLocation(program, 'uTime');
  var uEye = gl.getUniformLocation(program, 'uEye');
  var uKey = gl.getUniformLocation(program, 'uKey');

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.clearColor(0.016, 0.024, 0.037, 1);

  /* ---------- camera ---------- */
  var HOME = { x: 0, y: 22, z: 62, tx: 0, ty: 3, tz: 0 };
  var camera = { x: HOME.x, y: HOME.y, z: HOME.z, tx: HOME.tx, ty: HOME.ty, tz: HOME.tz };
  var target = { x: HOME.x, y: HOME.y, z: HOME.z, tx: HOME.tx, ty: HOME.ty, tz: HOME.tz };
  var orbit = 0;
  var dragging = false, lastX = 0;

  function goTo(roomId) {
    var room = null;
    for (var i = 0; i < ROOMS.length; i += 1) if (ROOMS[i].id === roomId) room = ROOMS[i];
    if (!room || room.ordinal === 1) {
      target = { x: HOME.x, y: HOME.y, z: HOME.z, tx: HOME.tx, ty: HOME.ty, tz: HOME.tz };
    } else {
      target = { x: room.camX, y: room.camY, z: room.camZ, tx: room.x, ty: 4.2, tz: room.z };
    }
    if (motion.reduced) { camera = { x: target.x, y: target.y, z: target.z, tx: target.tx, ty: target.ty, tz: target.tz }; }
    wake();
  }

  /* ---------- per-room state, supplied by the hydration runtime ---------- */
  var roomState = new Float32Array(18 * 4);
  var roomTint = new Float32Array(18 * 3);
  var anyMotion = false;
  window.__hqShellApply = function (views, activeRoomId) {
    anyMotion = false;
    for (var i = 0; i < roomState.length; i += 1) roomState[i] = 0;
    for (var j = 0; j < roomTint.length; j += 1) roomTint[j] = 0;
    for (var v = 0; v < views.length; v += 1) {
      var view = views[v];
      var slot = view.ordinal;
      if (!(slot >= 1 && slot <= 17)) continue;
      var color = LIVENESS_COLOR[view.liveness] || LIVENESS_COLOR.dark;
      // Intensity IS the liveness. A dark room gets 0.06 — enough for its
      // architecture to be visible, far too little to read as lit.
      var intensity = view.liveness === 'attention' ? 1.0
        : view.liveness === 'active' ? 0.82
        : view.liveness === 'quiet' ? 0.3
        : 0.06;
      // Motion only where canonical state is genuinely moving, and never at all
      // under reduced motion.
      var pulsing = (!motion.reduced && (view.liveness === 'active' || view.liveness === 'attention')) ? 1 : 0;
      if (pulsing) anyMotion = true;
      roomState[slot * 4] = intensity;
      roomState[slot * 4 + 1] = pulsing;
      roomState[slot * 4 + 2] = view.roomId === activeRoomId ? 1 : 0;
      roomTint[slot * 3] = color[0];
      roomTint[slot * 3 + 1] = color[1];
      roomTint[slot * 3 + 2] = color[2];
    }
    wake();
  };

  /* ---------- matrices ---------- */
  function multiply(a, b) {
    var out = new Float32Array(16);
    for (var r = 0; r < 4; r += 1) for (var c = 0; c < 4; c += 1) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return out;
  }
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var out = new Float32Array(16);
    out[0] = f / aspect; out[5] = f; out[10] = (far + near) / (near - far);
    out[11] = -1; out[14] = (2 * far * near) / (near - far);
    return out;
  }
  function lookAt(eye, center) {
    var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    var zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
    // x = normalize(cross(up, z)) with up = (0, 1, 0), written out.
    var xx = zz, xy = 0, xz = -zx;
    var xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    var out = new Float32Array(16);
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  /* ---------- loop ---------- */
  var width = 0, height = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (w !== width || h !== height) {
      width = w; height = h; canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  var running = false, frame = 0, idleFrames = 0, viewProj = null;
  function wake() { idleFrames = 0; if (!running) { running = true; frame = window.requestAnimationFrame(tick); } }

  function tick(now) {
    resize();
    var t = now / 1000;
    // Ease toward the target. Under reduced motion goTo() already snapped, so
    // this converges instantly and the loop is free to stop.
    var ease = motion.reduced ? 1 : 0.085;
    var moved = 0;
    for (var key in target) {
      var delta = target[key] - camera[key];
      camera[key] += delta * ease;
      moved += Math.abs(delta);
    }
    var drift = motion.reduced ? 0 : Math.sin(t * 0.11) * 1.6;
    var eye = [camera.x + Math.sin(orbit) * 6 + drift, camera.y, camera.z + Math.cos(orbit) * 6];
    var proj = perspective(0.85, width / Math.max(1, height), 0.6, 320);
    viewProj = multiply(proj, lookAt(eye, [camera.tx, camera.ty, camera.tz]));

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(uViewProj, false, viewProj);
    gl.uniform4fv(uRoom, roomState);
    gl.uniform3fv(uRoomTint, roomTint);
    gl.uniform1f(uTime, motion.reduced ? 0 : t);
    gl.uniform3f(uEye, eye[0], eye[1], eye[2]);
    gl.uniform3f(uKey, 0.35, 0.86, 0.38);
    gl.drawArrays(gl.TRIANGLES, 0, ${geometry.triangles * 3});
    positionLabels();

    // Stop the loop when nothing is moving. A still building costs nothing, and
    // under reduced motion that is the steady state within a frame or two.
    var busy = moved > 0.02 || anyMotion || dragging;
    idleFrames = busy ? 0 : idleFrames + 1;
    if (idleFrames > 3) { running = false; return; }
    frame = window.requestAnimationFrame(tick);
  }

  function project(x, y, z) {
    if (!viewProj) return null;
    var cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
    var cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    var cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (cw <= 0.001) return null;
    return { x: (cx / cw * 0.5 + 0.5), y: (1 - (cy / cw * 0.5 + 0.5)), w: cw };
  }

  function positionLabels() {
    if (!labelLayer) return;
    for (var i = 0; i < ROOMS.length; i += 1) {
      var room = ROOMS[i];
      var node = labelLayer.querySelector('[data-hq-label="' + room.id + '"]');
      if (!node) continue;
      var p = project(room.x, 10.5, room.z);
      if (!p || p.x < -0.1 || p.x > 1.1 || p.y < -0.1 || p.y > 1.1) { node.style.opacity = '0'; node.style.pointerEvents = 'none'; continue; }
      node.style.opacity = String(Math.max(0.25, Math.min(1, 1 - (p.w - 20) / 110)));
      node.style.pointerEvents = 'auto';
      node.style.left = (p.x * 100) + '%';
      node.style.top = (p.y * 100) + '%';
    }
  }

  /* ---------- input ---------- */
  canvas.addEventListener('pointerdown', function (event) {
    dragging = true; lastX = event.clientX;
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(event.pointerId); } catch (e) {} }
    wake();
  });
  canvas.addEventListener('pointermove', function (event) {
    if (!dragging) return;
    orbit += (event.clientX - lastX) * 0.005;
    lastX = event.clientX;
    wake();
  });
  function endDrag() { dragging = false; wake(); }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', function () { resize(); wake(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); });

  window.__hqShellGoTo = goTo;
  say('3D headquarters active. Rooms are lit only by canonical state; drag to look around, or use the room list below.', 'ok');
  wake();
})();
</script>`;
}
