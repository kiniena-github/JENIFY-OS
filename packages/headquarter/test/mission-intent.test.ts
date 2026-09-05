/**
 * The Intent Lock parser and decomposition (issue #254, D7 and D8).
 *
 * Every assertion here is about SHAPE: a written step becomes a step, a
 * written constraint becomes a constraint, and an order the rules cannot
 * read becomes a recorded clarification need with zero tasks — never a
 * plausible plan.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INTENT_UNKNOWN_CODES,
  INTENT_UNKNOWN_DESCRIPTIONS,
  MAX_MISSION_STEPS,
  parseFounderCommand,
  planFromIntent,
} from '../src/mission/intent.js';

const ORDER = [
  'Ship the Mesob shift-report export.',
  'Must not change the ledger schema.',
  'Never touch data/factoryos.sqlite.',
  'Done when the export opens in Excel.',
  'unknown: which date format the auditor wants',
  '1. Add the export endpoint',
  '2. Add the download control',
  '3. Write the regression test',
].join('\n');

describe('a written order is read as written', () => {
  const intent = parseFounderCommand(ORDER);

  it('takes the objective from the free sentence', () => {
    expect(intent.objective).toBe('Ship the Mesob shift-report export.');
  });

  it('collects constraints from must/never lines', () => {
    expect(intent.constraints).toEqual([
      'Must not change the ledger schema.',
      'Never touch data/factoryos.sqlite.',
    ]);
  });

  it('collects acceptance criteria from done-when lines', () => {
    expect(intent.acceptanceCriteria).toEqual(['the export opens in Excel.']);
  });

  it('records a declared unknown without letting it block the plan', () => {
    expect(intent.unknowns).toEqual([
      { code: 'founder_declared_unknown', blocking: false, detail: 'which date format the auditor wants' },
    ]);
    expect(intent.needsClarification).toBe(false);
  });

  it('turns numbered lines into steps, in order', () => {
    expect(intent.steps).toEqual([
      'Add the export endpoint',
      'Add the download control',
      'Write the regression test',
    ]);
  });

  it('is deterministic', () => {
    expect(parseFounderCommand(ORDER)).toEqual(intent);
  });

  it('composes one self-contained brief per step, carrying the objective, constraints, criteria and unknowns', () => {
    const briefs = planFromIntent(intent, 'Shift export');
    expect(briefs).toHaveLength(3);
    expect(briefs[1]).toContain('Mission: Shift export');
    expect(briefs[1]).toContain('Objective: Ship the Mesob shift-report export.');
    expect(briefs[1]).toContain('Step 2 of 3: Add the download control');
    expect(briefs[1]).toContain('- Never touch data/factoryos.sqlite.');
    expect(briefs[1]).toContain('- the export opens in Excel.');
    expect(briefs[1]).toContain('do not guess');
    expect(briefs[1]).toContain('- which date format the auditor wants');
  });
});

describe('an order with no steps is one task — the order itself, not an invention', () => {
  it('yields exactly one brief', () => {
    const intent = parseFounderCommand('Draft the Q3 maintenance plan for the Mesob line.');
    expect(intent.steps).toEqual([]);
    expect(intent.needsClarification).toBe(false);
    const briefs = planFromIntent(intent, 'Q3 plan');
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain('Objective: Draft the Q3 maintenance plan for the Mesob line.');
    expect(briefs[0]).not.toContain('Step ');
  });

  it('reads bullets as steps and a bulleted must-line as a constraint', () => {
    const intent = parseFounderCommand('Fix the login page.\n- must keep the session cookie HttpOnly\n- update the form\n- add a test');
    expect(intent.constraints).toEqual(['must keep the session cookie HttpOnly']);
    expect(intent.steps).toEqual(['update the form', 'add a test']);
  });
});

describe('ambiguity becomes needs_clarification and ZERO tasks — never a guessed plan', () => {
  const cases: [string, string][] = [
    ['', 'empty_objective'],
    ['   \n  ', 'empty_objective'],
    ['Should we move the warehouse to Adama?', 'question_not_order'],
    ['What is blocking the export?', 'question_not_order'],
    ['Migrate to either Postgres or keep SQLite, not sure yet.', 'unresolved_choice'],
    ['Deploy the TODO service to [environment].', 'placeholder_present'],
    ['Deploy', 'objective_too_short'],
  ];

  it.each(cases)('%j → %s, no steps, no brief', (command, code) => {
    const intent = parseFounderCommand(command);
    expect(intent.needsClarification).toBe(true);
    expect(intent.unknowns.map((entry) => entry.code)).toContain(code);
    expect(intent.unknowns.find((entry) => entry.code === code)!.blocking).toBe(true);
    expect(intent.steps).toEqual([]);
    expect(planFromIntent(intent, 'x')).toEqual([]);
  });

  it('refuses to plan more steps than the cap, and says so', () => {
    const many = Array.from({ length: MAX_MISSION_STEPS + 1 }, (_, i) => `${i + 1}. step ${i + 1}`).join('\n');
    const intent = parseFounderCommand(`Do the big thing.\n${many}`);
    expect(intent.needsClarification).toBe(true);
    expect(intent.unknowns.map((entry) => entry.code)).toContain('too_many_steps');
    expect(planFromIntent(intent, 'x')).toEqual([]);
  });

  it('still records the objective and constraints of an unreadable order, so an amendment can start from them', () => {
    const intent = parseFounderCommand('Should we ship the export?\nMust not change the schema.');
    expect(intent.objective).toBe('Should we ship the export?');
    expect(intent.constraints).toEqual(['Must not change the schema.']);
  });

  it('has a generic description for every unknown code, and none quotes the order', () => {
    for (const code of INTENT_UNKNOWN_CODES) {
      expect(INTENT_UNKNOWN_DESCRIPTIONS[code].length, code).toBeGreaterThan(20);
    }
    const intent = parseFounderCommand('Deploy the TODO service to [SECRET-ENV-NAME].');
    for (const entry of intent.unknowns) {
      expect(INTENT_UNKNOWN_DESCRIPTIONS[entry.code]).not.toContain('SECRET-ENV-NAME');
    }
  });
});

describe('the intent lock is append-only by construction', () => {
  it('has no UPDATE or DELETE against hq_mission_intent or hq_mission_events anywhere in src/', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/(UPDATE|DELETE\s+FROM)\s+hq_mission_(intent|events)/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
