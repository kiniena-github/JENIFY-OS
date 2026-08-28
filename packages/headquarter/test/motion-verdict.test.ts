/**
 * Regressions for the Headquarters Floor motion rule.
 *
 * Four consecutive Codex review rounds found this rule wrong, and every time
 * the mistake was in what the tool CONCLUDED, never in what it measured. The
 * browser measurement cannot be unit-tested — it needs a real style resolver,
 * and `evidence:states` is not in CI — so until now the rule was guarded only
 * by mutations I ran by hand and described in a PR comment. A described
 * mutation is not a regression: it does not run again.
 *
 * Each case below is one of those four historical failures, pinned as data.
 */

import { describe, expect, it } from 'vitest';
import { motionFailures, type FigureMotion } from '../tools/motion-verdict.js';

function animation(overrides: Partial<FigureMotion> = {}): FigureMotion {
  return {
    name: 'hq-work',
    duration: 2100,
    movesGeometrically: true,
    changesAnything: true,
    ...overrides,
  };
}

describe('an active figure must genuinely move', () => {
  it('accepts an animation that changes the figure geometrically', () => {
    expect(motionFailures('running', true, [animation()])).toEqual([]);
  });

  it('rejects a class that should animate when no animation reaches it', () => {
    // Round two: the name was recorded but nothing asserted it, so deleting
    // the rule outright changed no result.
    const [failure] = motionFailures('running', true, []);
    expect(failure).toContain('promises to animate');
    expect(failure).toContain('no animation reaches it');
  });

  it('rejects an animation whose keyframes never change anything', () => {
    // Round three: flattened keyframes, and a `0s` duration, both keep
    // `animationName` non-none while the figure stands still.
    const [failure] = motionFailures('running', true, [
      animation({ movesGeometrically: false, changesAnything: false }),
    ]);
    expect(failure).toContain('no change across phases');
    expect(failure).toContain('duration 2100ms');
  });

  it('rejects an animation that only changes colour or opacity', () => {
    // Round four, and the case ChatGPT asked to see pinned: a figure pulsing
    // `fill-opacity` is not a figure that moves, however lively it looks.
    const [failure] = motionFailures('running', true, [
      animation({ movesGeometrically: false, changesAnything: true }),
    ]);
    expect(failure).toContain('changes only colour/opacity');
    expect(failure).toContain('does not move geometrically');
  });

  it('accepts a moving animation even when a still one sits beside it', () => {
    // The rule asks whether ANY animation moves the figure, not whether all
    // of them do — a decorative static effect alongside real motion is not a
    // failure of the motion claim.
    expect(
      motionFailures('running', true, [
        animation({ name: 'hq-tint', movesGeometrically: false }),
        animation({ name: 'hq-work', movesGeometrically: true }),
      ]),
    ).toEqual([]);
  });
});

describe('a stalled figure must be still in every sense', () => {
  it('accepts a stalled figure carrying no animation at all', () => {
    expect(motionFailures('blocked', false, [])).toEqual([]);
  });

  it('rejects any animation on a stalled figure, even a purely geometric one', () => {
    const [failure] = motionFailures('blocked', false, [animation()]);
    expect(failure).toContain('stalled or idle state');
    expect(failure).toContain('asserts');
  });

  it('rejects a colour-only pulse on a stalled figure', () => {
    // The direction the tool could not see in ANY earlier version: nothing
    // moves, so a geometry-only check would pass it, yet the pulse still
    // tells the reader something is happening.
    const [failure] = motionFailures('needs_approval', false, [
      animation({ name: 'hq-screen', movesGeometrically: false, changesAnything: true }),
    ]);
    expect(failure).toContain('hq-screen');
    expect(failure).toContain('work that is not happening');
  });

  it('names every animation it found, so the report says what to remove', () => {
    const [failure] = motionFailures('offline', false, [
      animation({ name: 'hq-pulse' }),
      animation({ name: 'hq-screen' }),
    ]);
    expect(failure).toContain('hq-pulse');
    expect(failure).toContain('hq-screen');
  });
});

describe('the two directions are separate promises', () => {
  it('never reports both directions for one figure', () => {
    // A single blob comparison used to serve both questions, which is how the
    // colour-only case slipped through. They are now distinct rules, and a
    // figure can violate at most one of them.
    const shapes: FigureMotion[][] = [
      [],
      [animation()],
      [animation({ movesGeometrically: false, changesAnything: false })],
      [animation({ movesGeometrically: false, changesAnything: true })],
    ];
    for (const animations of shapes) {
      for (const mustMove of [true, false]) {
        expect(motionFailures('probe', mustMove, animations).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('treats geometric motion as necessary for the positive direction only', () => {
    // Same input, opposite promises, opposite verdicts — the property that
    // makes these two rules rather than one.
    const colourOnly = [animation({ movesGeometrically: false, changesAnything: true })];
    expect(motionFailures('running', true, colourOnly)).toHaveLength(1);
    expect(motionFailures('blocked', false, colourOnly)).toHaveLength(1);
    const moving = [animation()];
    expect(motionFailures('running', true, moving)).toHaveLength(0);
    expect(motionFailures('blocked', false, moving)).toHaveLength(1);
  });
});
