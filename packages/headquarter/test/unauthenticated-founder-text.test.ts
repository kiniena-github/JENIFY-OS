/**
 * The unauthenticated artifact IS a Founder-text publication surface —
 * disclosed rather than changed (Wave 5 correction round ten, NEW LOW).
 *
 * `hq-snapshot.json` is served with no authentication at all. The review named
 * ONE field, `snapshot.operations.data.queued[].title`. Measured here by
 * writing a distinctive string into each field and searching the whole
 * artifact, it is FOUR: a task's `title` and `project`, the `reason` a Founder
 * gave for a denial, and the derived `activity` / `commandCenter` summaries
 * that fold those strings in. The wider answer is what is recorded, in this
 * file and in `PHASE_13_ADVANCED_RELIABILITY.md`.
 *
 * That is almost certainly intended, and it is why scanning these columns is
 * load-bearing rather than tidy: they are the same columns a credential shape
 * permanently bricked Founder read routes through. It is also what makes the
 * task PAYLOAD's carve-out from the credential scan defensible — the payload is
 * the one piece of caller text that is neither served to a Founder route nor
 * published here, and its guard lives at the dispatch lane that would publish
 * it. That half is measured below too.
 *
 * What was missing is that nobody said so. The phase document's privacy section
 * is written entirely about the `reliability` section — "no run label, task id,
 * mission id … or finding detail string" — which is accurate about that section
 * and reads, to anyone composing a task, as though no free text crosses at all.
 *
 * So this file pins the disclosure in BOTH directions. If one of the four ever
 * stops crossing, or if the payload ever starts, the table in the phase
 * document becomes wrong and this fails. No behaviour is asserted here that the
 * code does not already have.
 */

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setupFixture, CAPS, expectOk } from './application.fixture.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';

const NOW = new Date('2026-09-08T09:00:00.000Z');

/** Every path in a snapshot at which `needle` appears inside a string. */
function pathsCarrying(value: unknown, needle: string, at = 'snapshot', out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.includes(needle)) out.push(at);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => pathsCarrying(entry, needle, `${at}[${index}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) pathsCarrying(entry, needle, `${at}.${key}`, out);
  }
  return out;
}

/** One denied task carrying a distinctive string in each Founder-typed field. */
function snapshotWithFounderText(): unknown {
  const fx = setupFixture();
  const created = expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.openPr,
      payload: { branch: 'main', instruction: 'PAYLOAD-MUST-NOT-BE-PUBLISHED' },
      idempotencyKey: 'disclosure-probe',
      requestedBy: 'claude',
      title: 'TITLE-IS-PUBLISHED',
      project: 'PROJECT-IS-PUBLISHED',
    }),
  );
  fx.ops.denyTask({
    taskId: created.task.id,
    founderId: 'founder',
    reason: 'REASON-IS-PUBLISHED',
  });
  return liveSnapshotFromOperations(fx.ops, { now: NOW.toISOString() });
}

describe('what Founder-typed text crosses to the unauthenticated artifact', () => {
  it('the task TITLE crosses, into the lane view and into the attention summary', () => {
    const paths = pathsCarrying(snapshotWithFounderText(), 'TITLE-IS-PUBLISHED');
    expect(paths).toContain('snapshot.operations.data.blocked[0].title');
    expect(paths).toContain('snapshot.commandCenter.data.attention.items[0].summary');
  });

  it('the task PROJECT crosses', () => {
    const paths = pathsCarrying(snapshotWithFounderText(), 'PROJECT-IS-PUBLISHED');
    expect(paths).toContain('snapshot.operations.data.blocked[0].project');
  });

  it('the Founder’s DENIAL REASON crosses — the field the review did not name', () => {
    const paths = pathsCarrying(snapshotWithFounderText(), 'REASON-IS-PUBLISHED');
    expect(paths).toContain('snapshot.operations.data.blocked[0].blockReason');
    expect(paths).toContain('snapshot.activity.data[0].summary');
    expect(paths).toContain('snapshot.commandCenter.data.attention.items[0].summary');
  });

  it('the task PAYLOAD does not cross — which is what makes its scan carve-out defensible', () => {
    expect(pathsCarrying(snapshotWithFounderText(), 'PAYLOAD-MUST-NOT-BE-PUBLISHED')).toEqual([]);
  });

  it('the phase document says so, in the section a reader would look in', () => {
    // The disclosure is only worth having if it is written down where the
    // privacy claim is made. If the row is deleted, this fails.
    const doc = new URL(
      '../../../docs/HEADQUARTER/PHASE_13_ADVANCED_RELIABILITY.md',
      import.meta.url,
    );
    const text = fs.readFileSync(doc, 'utf8');
    expect(text).toContain('The unauthenticated artifact IS a Founder-text publication surface');
    expect(text).toContain('four fields, not one');
    expect(text).toContain('denying it are public');
    expect(text).toContain('unauthenticated-founder-text.test.ts');
  });
});
