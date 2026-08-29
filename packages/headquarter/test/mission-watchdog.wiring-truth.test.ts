/**
 * The mission-watchdog claim, checked against the source tree (issue #219,
 * Codex correction round P1).
 *
 * The finding this suite answers: `classifyMission` / `shouldDispatchMission`
 * were delivered with tests and described as the fix for missions quietly
 * stopping — while nothing called them. Passing unit tests for a library no
 * runtime path invokes prove the rules are right; they prove nothing about the
 * failure being prevented, and the acceptance report read as though they did.
 *
 * So the claim is now a value (`MISSION_WATCHDOG_RUNTIME_CONSUMERS`) and this
 * suite is what keeps it honest, in both directions:
 *
 * - wire the watchdog and leave the notice saying it is unwired → this fails;
 * - delete the notice while it is still unwired → this fails.
 *
 * It reads the real files from the repo root resolved from this file's own
 * location, never from the CWD, so the pin holds wherever the suite is run.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MISSION_WATCHDOG_RUNTIME_CONSUMERS,
  MISSION_WATCHDOG_STATUS,
} from '../src/application/mission-watchdog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const MODULE_PATH = join(HERE, '..', 'src', 'application', 'mission-watchdog.ts');

/** The decision entry points. A runtime call to any of them is wiring. */
const DECISION_FUNCTIONS = [
  'classifyMission',
  'shouldDispatchMission',
  'activeMissionWorkers',
  'actionableMissionBlockers',
  'assertCanonicalLane',
  'describeMissionDecision',
];

/**
 * Where a consumer could live. `.github` is included deliberately: the dispatch
 * loop this module describes is a workflow, so wiring would most likely appear
 * there rather than in a package.
 */
const SEARCH_ROOTS = [
  join(REPO_ROOT, 'packages', 'headquarter', 'src'),
  join(REPO_ROOT, 'packages', 'server', 'src'),
  join(REPO_ROOT, 'packages', 'web', 'src'),
  join(REPO_ROOT, 'packages', 'shared', 'src'),
  join(REPO_ROOT, 'packages', 'config-mesob', 'src'),
  join(REPO_ROOT, '.github'),
  join(REPO_ROOT, 'tools'),
];

const SEARCHED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.yml', '.yaml'];

/**
 * Not consumers, and excluded for stated reasons rather than convenience:
 * the module is allowed to define its own functions, and a barrel re-export
 * makes a symbol importable without anything importing it.
 */
const NOT_A_CONSUMER = [
  join('packages', 'headquarter', 'src', 'application', 'mission-watchdog.ts'),
  join('packages', 'headquarter', 'src', 'application', 'index.ts'),
];

function walk(root: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return found; // A search root that does not exist searches to nothing.
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.git')) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      walk(full, found);
    } else if (SEARCHED_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      found.push(full);
    }
  }
  return found;
}

function runtimeConsumers(): string[] {
  const hits = new Set<string>();
  for (const root of SEARCH_ROOTS) {
    for (const file of walk(root)) {
      const rel = relative(REPO_ROOT, file);
      if (NOT_A_CONSUMER.includes(rel)) continue;
      // Tests exercise the library by definition; they are not wiring.
      if (rel.split(sep).includes('test') || rel.includes('.test.')) continue;
      const source = readFileSync(file, 'utf8');
      if (DECISION_FUNCTIONS.some((name) => new RegExp(`\\b${name}\\b`).test(source))) {
        hits.add(rel.split(sep).join('/'));
      }
    }
  }
  return [...hits].sort();
}

describe('the mission watchdog claims exactly what it is', () => {
  it('has the runtime consumers it says it has — no more, no fewer', () => {
    // The whole point. If someone wires it, this fails until the recorded
    // consumer list and the status notice are brought back into line with
    // reality; if someone quietly unwires it, this fails too.
    expect(runtimeConsumers()).toEqual([...MISSION_WATCHDOG_RUNTIME_CONSUMERS].sort());
  });

  it('reports decision-rules-only while nothing consumes it', () => {
    if (MISSION_WATCHDOG_RUNTIME_CONSUMERS.length === 0) {
      expect(MISSION_WATCHDOG_STATUS).toBe('decision_rules_only');
    }
  });

  it('says in the module itself that the quiet stop is not operationally fixed', () => {
    // Prose can drift out of a report, so the honest sentence is pinned where
    // the code is read. These are the load-bearing phrases; rewording them is
    // fine, deleting the admission is not.
    // Comment wrapping and `*` gutters are not meaning: flatten them so a
    // reflow cannot silently unpin the sentence.
    const prose = readFileSync(MODULE_PATH, 'utf8')
      .replace(/^\s*\*/gm, ' ')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ');
    expect(prose).toContain('UNWIRED');
    expect(prose).toContain('Nothing in this repository calls these functions at runtime');
    expect(prose).toContain('the quiet stop is not fixed by this module existing');
    // And that automatic resume is named as the authority widening it is,
    // rather than being taken quietly.
    expect(prose).toContain('widening of execution authority');
  });

  it('names the dispatch path that actually decides when a worker wakes', () => {
    // The reader must be able to check the claim. The workflow named here is
    // the one that fires the routine, and it exists.
    const source = readFileSync(MODULE_PATH, 'utf8').replace(/\s+/g, ' ');
    expect(source).toContain('.github/workflows/ai-task-trigger.yml');
    const workflow = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'ai-task-trigger.yml'),
      'utf8',
    );
    expect(workflow).toContain('jenify-run');
    // And it is genuinely comment-driven: no schedule, so nothing re-triggers
    // a stalled mission on its own today.
    expect(workflow).not.toMatch(/^\s*schedule:/m);
  });
});
