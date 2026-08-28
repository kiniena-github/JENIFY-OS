/**
 * The decision rule behind the Headquarters Floor motion evidence.
 *
 * Split out of `state-visual-evidence.ts` so it can be unit-tested. The
 * browser measurement cannot be: it needs a real style resolver, and that tool
 * is not in CI. But the measurement was never the part that was wrong — the
 * RULE was, four times running, each time in a way that let a broken page pass:
 *
 *   1. read the animation at the leaf, so a name on an ancestor group was
 *      invisible;
 *   2. record the name but assert nothing, so deleting the animation changed
 *      nothing;
 *   3. assert the name is present, though a name is not motion — flattened
 *      keyframes and a `0s` duration both kept the name;
 *   4. treat ANY animated property as motion, so a figure pulsing `fill` while
 *      standing geometrically still counted as moving.
 *
 * Every one of those was a mistake in what the tool concluded from what it
 * saw. So the conclusion lives here, in a pure function over plain data, with
 * a test that fixes each of the four regressions in place.
 *
 * The two directions take DIFFERENT signals, because the floor makes two
 * different promises and one comparison cannot carry both:
 *
 *   positive  an active figure MOVES — only a geometric change counts
 *   negative  a stalled figure is still in every sense — ANY animation fails,
 *             since a colour pulse on a blocked worker still asserts that
 *             something is happening
 */

export interface FigureMotion {
  /** The CSS animation name, for the failure message. */
  name: string;
  /** Effective duration in ms, for the failure message. */
  duration: number;
  /** The figure's GEOMETRY changes across the animation's own timeline. */
  movesGeometrically: boolean;
  /** Anything at all changes — colour, opacity, geometry. */
  changesAnything: boolean;
}

/**
 * What is wrong with this figure's motion, if anything.
 *
 * @param label      the activity being reported, for the message
 * @param mustMove   whether the floor promises this class is in motion
 * @param animations every animation measured on the figure
 * @returns one message per problem; empty when the figure is correct
 */
export function motionFailures(
  label: string,
  mustMove: boolean,
  animations: readonly FigureMotion[],
): string[] {
  const failures: string[] = [];

  if (mustMove && !animations.some((entry) => entry.movesGeometrically)) {
    // Name which of the three causes it is: they need different repairs, and
    // an undifferentiated "it does not move" sent me looking in the wrong
    // place more than once.
    const detail =
      animations.length === 0
        ? 'no animation reaches it'
        : `inert or non-geometric: ${animations
            .map(
              (entry) =>
                `${entry.name} (duration ${entry.duration}ms, ` +
                `${entry.changesAnything ? 'changes only colour/opacity' : 'no change across phases'})`,
            )
            .join(', ')}`;
    failures.push(
      `activity: ${label} is a class the floor promises to animate, but its figure does not ` +
        `move geometrically in the browser — ${detail}`,
    );
  }

  if (!mustMove && animations.length > 0) {
    failures.push(
      `activity: ${label} is a stalled or idle state, but its figure carries an animation ` +
        `(${animations.map((entry) => entry.name).join(', ')}) — any motion here asserts ` +
        'work that is not happening',
    );
  }

  return failures;
}
