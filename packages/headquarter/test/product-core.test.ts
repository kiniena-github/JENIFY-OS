/**
 * Phase 12's pure core: vocabulary, lifecycle algebra, derivation, templates,
 * the release gate and the snapshot fold.
 *
 * Database-free on purpose, so nothing asserted here can be satisfied by an
 * accident of fixture data. The load-bearing properties:
 *
 *  - the product lifecycle vocabulary is DISJOINT from the canonical task and
 *    mission vocabularies, so no reader and no future refactor can confuse a
 *    product state with worker state;
 *  - the lifecycle algebra is total, advances one step and never skips;
 *  - the derivation reads the lifecycle out of the append-only event ledger,
 *    so there is no column for a state to disagree with;
 *  - a template is a value with no id in it, and says so on its face;
 *  - release readiness is an observation that authorizes nothing, whatever
 *    its blocker list says;
 *  - the snapshot fold produces counts over closed vocabularies and carries
 *    no free text at all.
 */

import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_DIGEST_PROVENANCES,
  PRODUCT_ARTIFACT_KINDS,
  PRODUCT_INITIAL_LIFECYCLE,
  PRODUCT_LIFECYCLE_STATES,
  PRODUCT_PLAN_TEMPLATES,
  PRODUCT_RELEASE_BLOCKERS,
  PRODUCT_TYPES,
  allowedProductLifecycleMoves,
  artifactRecordDigest,
  canMoveProductLifecycle,
  deriveProductRecord,
  emptyProductFactorySnapshot,
  isProductArtifactKind,
  isProductLifecycleState,
  isProductType,
  productPlanRecommendation,
  productPlanTemplateFor,
  productReleaseReadiness,
  summarizeProductFactory,
  type ProductArtifactKind,
  type ProductArtifactRow,
  type ProductEventRow,
  type ProductLifecycleState,
  type ProductRecord,
  type ProductRow,
} from '../src/application/product-command.js';
import { ACTIVITY_STATUSES } from '../src/contracts/events.js';
import { MISSION_STATUSES } from '../src/contracts/mission.js';

/* ------------------------------------------------------------------ */
/* Builders — plain values, no database                                */
/* ------------------------------------------------------------------ */

function row(over: Partial<ProductRow> = {}): ProductRow {
  return {
    seq: 1,
    id: 'product-1',
    projectId: 'project-1',
    productType: 'web',
    name: 'Console',
    problem: 'A stated problem',
    targetUsers: 'Stated users',
    summary: null,
    createdBy: 'founder',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

let eventSeq = 0;
function event(over: Partial<ProductEventRow> = {}): ProductEventRow {
  eventSeq += 1;
  return {
    seq: eventSeq,
    id: `event-${eventSeq}`,
    productId: 'product-1',
    at: `2026-09-0${Math.min(eventSeq, 9)}T00:00:00.000Z`,
    actor: 'founder',
    kind: 'lifecycle_moved',
    fromState: null,
    toState: null,
    note: null,
    detail: null,
    ...over,
  };
}

let artifactSeq = 0;
function artifact(over: Partial<ProductArtifactRow> = {}): ProductArtifactRow {
  artifactSeq += 1;
  return {
    seq: artifactSeq,
    id: `artifact-${artifactSeq}`,
    productId: 'product-1',
    kind: 'specification',
    name: 'spec',
    version: 1,
    locator: 'docs/spec.md',
    contentDigest: null,
    digestProvenance: 'not_provided',
    recordDigest: 'digest',
    note: null,
    recordedBy: 'founder',
    recordedAt: '2026-09-02T00:00:00.000Z',
    ...over,
  };
}

function record(over: {
  events?: ProductEventRow[];
  artifacts?: ProductArtifactRow[];
  row?: Partial<ProductRow>;
} = {}): ProductRecord {
  return deriveProductRecord({
    row: row(over.row),
    events: over.events ?? [event({ kind: 'registered', toState: 'idea' })],
    artifacts: over.artifacts ?? [],
    capability: null,
  });
}

/* ------------------------------------------------------------------ */

describe('the vocabulary is closed, total and NOT task truth', () => {
  it('shares no member with the canonical task or mission vocabularies', () => {
    // The load-bearing assertion of the whole phase's vocabulary: a product
    // state and a task state can never be mistaken for one another, by a
    // reader or by a future refactor that starts comparing strings.
    const activity = new Set<string>(ACTIVITY_STATUSES as readonly string[]);
    const missions = new Set<string>(MISSION_STATUSES as readonly string[]);
    for (const state of PRODUCT_LIFECYCLE_STATES) {
      expect(activity.has(state), `${state} must not be a task status`).toBe(false);
      expect(missions.has(state), `${state} must not be a mission status`).toBe(false);
    }
  });

  it('recognizes exactly its own members and nothing else', () => {
    for (const type of PRODUCT_TYPES) expect(isProductType(type)).toBe(true);
    for (const state of PRODUCT_LIFECYCLE_STATES) expect(isProductLifecycleState(state)).toBe(true);
    for (const kind of PRODUCT_ARTIFACT_KINDS) expect(isProductArtifactKind(kind)).toBe(true);
    for (const impostor of ['queued', 'completed', 'active', 'RELEASED', '', 'released ']) {
      expect(isProductLifecycleState(impostor)).toBe(false);
    }
    expect(isProductType('saas')).toBe(false);
    expect(isProductArtifactKind('binary')).toBe(false);
  });

  it('names the eight product types the brief listed, and starts every product at idea', () => {
    expect([...PRODUCT_TYPES].sort()).toEqual([
      'ai_workflow',
      'backend_service',
      'desktop',
      'firmware',
      'hardware_iot_concept',
      'media_technology',
      'mobile',
      'web',
    ]);
    expect(PRODUCT_INITIAL_LIFECYCLE).toBe('idea');
    expect(PRODUCT_LIFECYCLE_STATES[0]).toBe('idea');
    expect(PRODUCT_LIFECYCLE_STATES[PRODUCT_LIFECYCLE_STATES.length - 1]).toBe('released');
  });

  it('offers no digest provenance that claims verification', () => {
    // HQ never fetches an artifact, so there is deliberately no `verified`
    // member for a caller to reach for.
    expect([...ARTIFACT_DIGEST_PROVENANCES]).toEqual(['declared_by_recorder', 'not_provided']);
    expect(ARTIFACT_DIGEST_PROVENANCES as readonly string[]).not.toContain('verified');
  });
});

describe('the lifecycle algebra advances one step and never skips', () => {
  it('allows exactly the next state forward, and any earlier state back', () => {
    for (let at = 0; at < PRODUCT_LIFECYCLE_STATES.length; at += 1) {
      const from = PRODUCT_LIFECYCLE_STATES[at]!;
      for (let to = 0; to < PRODUCT_LIFECYCLE_STATES.length; to += 1) {
        const target = PRODUCT_LIFECYCLE_STATES[to]!;
        const expected = to === at + 1 || to < at;
        expect(canMoveProductLifecycle(from, target), `${from} -> ${target}`).toBe(expected);
      }
    }
  });

  it('refuses a self-move and every forward skip', () => {
    expect(canMoveProductLifecycle('idea', 'idea')).toBe(false);
    expect(canMoveProductLifecycle('idea', 'build')).toBe(false);
    expect(canMoveProductLifecycle('idea', 'released')).toBe(false);
    expect(canMoveProductLifecycle('specification', 'release_candidate')).toBe(false);
  });

  it('lets a released product go back into build, because products genuinely regress', () => {
    expect(canMoveProductLifecycle('released', 'build')).toBe(true);
    expect(canMoveProductLifecycle('review', 'build')).toBe(true);
    expect(allowedProductLifecycleMoves('idea')).toEqual(['research']);
    expect(allowedProductLifecycleMoves('released')).toEqual(
      PRODUCT_LIFECYCLE_STATES.filter((state) => state !== 'released'),
    );
  });
});

describe('the record is DERIVED from the append-only ledger', () => {
  it('reads idea from the registration event alone', () => {
    const derived = record();
    expect(derived.lifecycle).toBe('idea');
    expect(derived.lifecycleChangedAt).toBeNull();
    expect(derived.lifecycleChangedBy).toBeNull();
  });

  it('reads the LAST move, not the first, and reports who made it', () => {
    const derived = record({
      events: [
        event({ kind: 'registered', toState: 'idea' }),
        event({ fromState: 'idea', toState: 'research', actor: 'founder' }),
        event({ fromState: 'research', toState: 'specification', actor: 'founder' }),
        // A regression: the ledger keeps both, and the state is the last one.
        event({ fromState: 'specification', toState: 'research', actor: 'founder' }),
      ],
    });
    expect(derived.lifecycle).toBe('research');
    expect(derived.lifecycleChangedBy).toBe('founder');
    expect(derived.history).toHaveLength(4);
    // History is never rewritten: the superseded states are all still there.
    expect(derived.history.map((entry) => entry.toState)).toEqual([
      'idea',
      'research',
      'specification',
      'research',
    ]);
  });

  it('marks only the highest version of each artifact line as latest', () => {
    const derived = record({
      artifacts: [
        artifact({ kind: 'specification', name: 'spec', version: 1 }),
        artifact({ kind: 'specification', name: 'spec', version: 2 }),
        artifact({ kind: 'test_report', name: 'suite', version: 1 }),
      ],
    });
    const latest = derived.artifacts.filter((entry) => entry.latest);
    expect(latest.map((entry) => `${entry.kind}:${entry.version}`).sort()).toEqual([
      'specification:2',
      'test_report:1',
    ]);
    expect(derived.artifactTotal).toBe(3);
    // Every artifact carries the honesty statement about its digests.
    for (const entry of derived.artifacts) {
      expect(entry.digestStatement).toContain('never verified');
    }
  });

  it('states on every product that it cannot execute externally', () => {
    const derived = record();
    expect(derived.authority.executesExternally).toBe(false);
    expect(derived.authority.founderOnly).toBe(true);
    expect(derived.lifecycleStatement).toContain('not a task status');
  });
});

describe('the record digest covers the row and nothing else', () => {
  it('is stable for identical inputs and moves for every field', () => {
    const inputs = {
      productId: 'product-1',
      kind: 'build_artifact' as const,
      name: 'bundle',
      version: 3,
      locator: 'dist/bundle.tgz',
      contentDigest: 'b'.repeat(64),
      digestProvenance: 'declared_by_recorder' as const,
      note: null,
      recordedBy: 'founder',
      recordedAt: '2026-09-03T00:00:00.000Z',
    };
    const base = artifactRecordDigest(inputs);
    expect(artifactRecordDigest({ ...inputs })).toBe(base);
    expect(artifactRecordDigest({ ...inputs, version: 4 })).not.toBe(base);
    expect(artifactRecordDigest({ ...inputs, locator: 'dist/other.tgz' })).not.toBe(base);
    expect(artifactRecordDigest({ ...inputs, contentDigest: 'c'.repeat(64) })).not.toBe(base);
    expect(artifactRecordDigest({ ...inputs, recordedBy: 'analyst' })).not.toBe(base);
  });
});

describe('a template proposes and never grants', () => {
  it('covers every product type exactly once', () => {
    expect(PRODUCT_PLAN_TEMPLATES.map((template) => template.productType).sort()).toEqual(
      [...PRODUCT_TYPES].sort(),
    );
    for (const type of PRODUCT_TYPES) expect(productPlanTemplateFor(type).productType).toBe(type);
  });

  it('carries no id, no capability and no handle a route could act on', () => {
    const plan = productPlanRecommendation({ id: 'product-1', productType: 'web' });
    expect(plan.grantsAuthority).toBe(false);
    expect(plan.createsNothing).toBe(true);
    expect(plan.canonicalPath).toContain('hq.mission_command');
    expect(plan.statement).toContain('RECOMMENDATION');
    // The load-bearing shape check: a mission proposal is a title, an
    // objective and plan items — never an id, a capability or a grant.
    for (const mission of plan.missions) {
      expect(Object.keys(mission).sort()).toEqual(['objective', 'planItems', 'title']);
    }
    // The whole shape is pinned, so a future field cannot appear here
    // unnoticed: a plan is a product reference, a template reference, the
    // proposed missions, and three statements that deny authority.
    expect(Object.keys(plan).sort()).toEqual([
      'canonicalPath',
      'createsNothing',
      'grantsAuthority',
      'missions',
      'productId',
      'productType',
      'statement',
      'templateId',
      'templateStatement',
    ]);
    // And the proposed missions themselves carry no handle of any kind. The
    // scan is over the missions, not the statements: the statements
    // deliberately use the words `grant` and `execute` in order to deny them,
    // and a scan that tripped on the phase's own honesty would prove nothing.
    const encodedMissions = JSON.stringify(plan.missions);
    for (const forbidden of ['missionId', 'taskId', 'capabilityId', 'approvalId', 'grant', 'execute']) {
      expect(encodedMissions, `a proposed mission must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never invents a specialty step HQ has no knowledge behind', () => {
    // A firmware template that produced a signing, certification or OTA step
    // would be inventing a business rule; each is named as deliberately absent
    // instead, which is the honest form of the same information.
    const firmware = productPlanTemplateFor('firmware');
    const encodedMissions = JSON.stringify(firmware.missions).toLowerCase();
    for (const forbidden of ['flash', 'sign', 'over-the-air', 'certif']) {
      expect(encodedMissions, `firmware missions must not include ${forbidden}`).not.toContain(forbidden);
    }
    expect(firmware.statement).toContain('deliberately absent');
    const hardware = productPlanTemplateFor('hardware_iot_concept');
    expect(hardware.statement).toContain('inventing a business rule');
  });
});

describe('release readiness observes, and authorizes nothing', () => {
  function readiness(lifecycle: ProductLifecycleState, kinds: string[]) {
    return productReleaseReadiness(
      record({
        events: [
          event({ kind: 'registered', toState: 'idea' }),
          event({ fromState: 'idea', toState: lifecycle }),
        ],
        artifacts: kinds.map((kind, index) =>
          artifact({ kind: kind as ProductArtifactKind, name: `a${index}`, version: 1 }),
        ),
      }),
    );
  }

  it('names every blocker for an empty idea-stage product', () => {
    const view = readiness('research', []);
    expect(view.blockers.map((blocker) => blocker.code).sort()).toEqual([...PRODUCT_RELEASE_BLOCKERS].sort());
    expect(view.authorizesRelease).toBe(false);
  });

  it('clears its blockers only when the record genuinely carries them', () => {
    const view = readiness('release_candidate', ['release_candidate', 'specification', 'test_report']);
    expect(view.blockers).toEqual([]);
    // And STILL authorizes nothing. This is the assertion the phase turns on:
    // a clean readiness answer is not an approval and not a release.
    expect(view.authorizesRelease).toBe(false);
    expect(view.externalActionPath).toBe('phase_8_action_gateway');
    expect(view.statement).toContain('never an authorization');
    expect(view.statement).toContain('Phase 8 gateway');
  });

  it('holds the lifecycle blocker until release_candidate is actually reached', () => {
    const kinds = ['release_candidate', 'specification', 'test_report'];
    expect(readiness('review', kinds).blockers.map((blocker) => blocker.code)).toEqual([
      'lifecycle_before_release_candidate',
    ]);
    expect(readiness('release_candidate', kinds).blockers).toEqual([]);
  });
});

describe('the snapshot fold is counts over closed vocabularies', () => {
  it('starts every vocabulary member at zero and states absence honestly', () => {
    const empty = emptyProductFactorySnapshot(false);
    expect(empty.storePresent).toBe(false);
    expect(Object.keys(empty.byType).sort()).toEqual([...PRODUCT_TYPES].sort());
    expect(Object.keys(empty.byLifecycle).sort()).toEqual([...PRODUCT_LIFECYCLE_STATES].sort());
    expect(Object.keys(empty.artifactsByKind).sort()).toEqual([...PRODUCT_ARTIFACT_KINDS].sort());
    expect(Object.values(empty.byLifecycle).every((count) => count === 0)).toBe(true);
  });

  it('counts records and carries no name, locator, digest or id', () => {
    const products = [
      record({ row: { id: 'product-1', name: 'Palladium Console', productType: 'web' } }),
      record({
        row: { id: 'product-2', name: 'Iridium Firmware', productType: 'firmware' },
        events: [
          event({ kind: 'registered', toState: 'idea' }),
          event({ fromState: 'idea', toState: 'research' }),
        ],
      }),
    ];
    const view = summarizeProductFactory({
      storePresent: true,
      products,
      artifactTotal: 3,
      artifactKinds: ['specification', 'specification', 'test_report'],
    });
    expect(view.products).toBe(2);
    expect(view.byType.web).toBe(1);
    expect(view.byType.firmware).toBe(1);
    expect(view.byLifecycle.idea).toBe(1);
    expect(view.byLifecycle.research).toBe(1);
    expect(view.artifacts).toBe(3);
    expect(view.artifactsByKind.specification).toBe(2);
    expect(view.artifactsByKind.test_report).toBe(1);

    // The disclosure assertion: nothing free-text from a product crosses.
    // The note is the section's own statement of what it withholds, so it
    // names the withheld field kinds; the scan is over the DATA.
    const encoded = JSON.stringify({ ...view, note: null });
    for (const secret of ['Palladium', 'Iridium', 'product-1', 'product-2', 'docs/', 'digest']) {
      expect(encoded, `the snapshot fold must not carry ${secret}`).not.toContain(secret);
    }
    expect(view.note).toContain('no product name');
    expect(view.note).toContain('not a statement that anything was released');
  });
});
