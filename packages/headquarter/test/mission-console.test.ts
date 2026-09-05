/**
 * The Founder Command + Mission Room console surface (issue #254).
 *
 * Structural guarantees, checked without a browser: the static Command
 * Center carries the mount and no control; the console binds every path to
 * the canonical route verbatim; the grant rule is deny-by-default for the
 * three new controls; the transition targets are emitted from the server's
 * own table; and the immersive runtime still performs no write.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import { CONTROL_GRANT_JS, CONTROL_FETCH_TARGETS, founderCommandConsoleScript } from '../src/ui/control-console.js';
import { CONTROL_ROUTES } from '../src/live/control-api.js';
import { CLIENT_FETCH_TARGETS } from '../src/client/runtime.js';
import { MISSION_TRANSITIONS } from '../src/mission/states.js';
import { roomById } from '../src/client/rooms.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;
const site = buildSite(sample);
const index = site.get('index.html')!;
const immersive = site.get('immersive.html')!;

type Grant = { founderCommand: boolean; missionAmend: boolean; missionTransition: boolean; reason: string };
const grantedControls = new Function(`${CONTROL_GRANT_JS}; return grantedControls;`)() as (session: unknown) => Grant;

describe('the Command Center carries the Founder Command mount, inert', () => {
  it('renders the section, the mount and the honest blocker text, with no control', () => {
    expect(index).toContain('FOUNDER COMMAND · MISSION ROOM');
    expect(index).toContain('<div data-founder-command-console></div>');
    expect(index).toContain('ZERO tasks and asks for clarification');
    expect(index).not.toContain('<button');
    expect(index).not.toContain('<form');
  });

  it('binds every mission path to the canonical route, verbatim', () => {
    expect(index).toContain(`var MISSIONS_PATH = ${JSON.stringify(CONTROL_ROUTES.missions)};`);
    expect(index).toContain(`var MISSION_AMEND_PATH = ${JSON.stringify(CONTROL_ROUTES.missionAmend)};`);
    expect(index).toContain(`var MISSION_TRANSITION_PATH = ${JSON.stringify(CONTROL_ROUTES.missionTransition)};`);
    for (const route of [CONTROL_ROUTES.missions, CONTROL_ROUTES.missionAmend, CONTROL_ROUTES.missionTransition]) {
      expect(CONTROL_FETCH_TARGETS).toContain(route);
    }
  });

  it('emits the transition targets from the server’s own table', () => {
    const script = founderCommandConsoleScript();
    expect(script).toContain(`var TRANSITIONS = ${JSON.stringify(MISSION_TRANSITIONS)};`);
  });

  it('states every access state it can be in', () => {
    const script = founderCommandConsoleScript();
    for (const state of ['checking', 'unauthenticated', 'unauthorized', 'unavailable', 'offline', 'error', 'live']) {
      expect(script, state).toContain(`'${state}'`);
    }
    // And says what the zero means.
    expect(script).toContain('Zero is the recorded answer, not a loading state.');
    // And never draws the order text, because it never receives it.
    expect(script).toContain('stay server-side');
  });

  it('links the Mission Room’s long form to the page that holds the console', () => {
    expect(roomById('mission-room')!.page).toBe('index.html');
  });
});

describe('the grant rule is deny-by-default for the three mission controls', () => {
  it('grants nothing for a hostile session answer', () => {
    for (const hostile of [undefined, null, {}, { ok: true, founder: true }, { ok: true, founder: true, controls: 'all' }]) {
      const verdict = grantedControls(hostile);
      expect(verdict.founderCommand, JSON.stringify(hostile)).toBe(false);
      expect(verdict.missionAmend, JSON.stringify(hostile)).toBe(false);
      expect(verdict.missionTransition, JSON.stringify(hostile)).toBe(false);
    }
  });

  it('treats truthy-but-not-true flags as not granted, and literal true as granted', () => {
    expect(
      grantedControls({ ok: true, founder: true, controls: { founderCommand: 'yes', missionAmend: 1, missionTransition: {} } }),
    ).toMatchObject({ founderCommand: false, missionAmend: false, missionTransition: false });
    expect(
      grantedControls({ ok: true, founder: true, controls: { founderCommand: true, missionAmend: false, missionTransition: true } }),
    ).toMatchObject({ founderCommand: true, missionAmend: false, missionTransition: true });
  });
});

describe('the immersive runtime still performs no write', () => {
  it('declares only its two read routes, and the page names no mission route', () => {
    expect([...CLIENT_FETCH_TARGETS].sort()).toEqual([CONTROL_ROUTES.session, CONTROL_ROUTES.state].sort());
    for (const route of [CONTROL_ROUTES.missions, CONTROL_ROUTES.missionAmend, CONTROL_ROUTES.missionTransition]) {
      expect(immersive).not.toContain(route);
    }
  });
});
