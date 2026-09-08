/**
 * The facade CALL GRAPH, shared by every guard that needs to know which public
 * methods of `HeadquarterOperations` can reach a write (Wave 5 correction round
 * fourteen, Critical 1).
 *
 * Extracted verbatim from `facade-write-scan.test.ts`, which built it for the
 * credential-scan coverage question, so that the enforcement-safe-read guard in
 * `enforcement-safe-reads.test.ts` asks its question over the SAME classification
 * rather than a second one. Two derivations of "does this method write" is
 * exactly how a method that is a write to one guard and a read to the other ends
 * up checked by neither — the shape `source-members.ts` was extracted for, one
 * level up.
 *
 * The segmentation itself is `source-members.ts`; this file is only the
 * write-reachability fixpoint over it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classMemberSlices } from './source-members.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(HERE, '..', 'src', 'application', 'service.ts');

export interface MethodSlice {
  name: string;
  /** The source from this declaration to the next one. */
  body: string;
  /** The line the declaration starts on, zero-based. */
  line: number;
}

export const CONTROL_WORDS = new Set([
  'if',
  'for',
  'switch',
  'while',
  'catch',
  'return',
  'constructor',
  'do',
  'else',
  'try',
]);

/**
 * Markers that a method body writes DIRECTLY.
 *
 * Kept exactly as it was, because it is no longer the classifier — it is the
 * base case of one. `writeClassifiedMethods()` closes it over the class's own
 * call graph, which is what a public method whose only write lives in a
 * `#private` helper needs (round thirteen, Medium 1).
 */
export const WRITE_MARKERS =
  /(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)|appendEvidence\(|appendEvent\(|#upsertMeta\(|#requirePrivilegedQueue\(\)|postMessage\(|registry\.(?:register|disable|setHealth|assign|update)\(|#workerProviderRegistrar\.|#appendRunEvent\(|this\.queue\.(?:start|heartbeat|complete|fail|claim)\(/;


/**
 * Every member of `HeadquarterOperations`, `#private` ones included, sliced
 * from its declaration to the next.
 *
 * The `#private` members are why this exists: they are never part of the
 * answer — the surface under test is public — but they are how a public method
 * reaches a write, so the graph has to contain them.
 *
 * The segmentation moved to `source-members.ts` (Wave 5 correction round
 * fourteen, Medium 15). The regex that used to live here —
 * `/^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/` — could not see a member declared
 * `async`, `static`, `get`, `set`, `private`, `protected` or `override`, and an
 * unseen member is not skipped but FOLDED INTO THE PREVIOUS SLICE: the previous
 * method is credited with writes and parameters that are not its own, and the
 * unseen one contributes no (method, parameter) pair at all. Measured at
 * `3fcc271`: 249 visible, one invisible (`get policyContext()`).
 */
export function methodSlices(): MethodSlice[] {
  const source = fs.readFileSync(SERVICE, 'utf8');
  const classStart = source
    .split('\n')
    .findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  if (classStart < 0) throw new Error('service.ts declares no HeadquarterOperations class');
  return classMemberSlices(source, { fromLine: classStart, exclude: CONTROL_WORDS }).map((slice) => ({
    name: slice.name,
    line: slice.line,
    body: slice.body,
  }));
}

/**
 * Every PUBLIC method that reaches a write, directly or through the class's own
 * call graph — the same fixpoint `safe-mode-disposition.test.ts` computes for
 * the safe-mode dispositions, applied here to the credential scan.
 *
 * Over-approximating on purpose. An edge is any `this.name(` or `this.#name(`
 * the body mentions, with no attempt to decide whether the branch holding it
 * can be taken, so the answer is a SUPERSET of what actually writes. That
 * direction is the safe one: a method wrongly included has to scan its
 * parameters or be named in `EXEMPT_PARAMETERS` with its reason, and a method
 * wrongly excluded is exactly the class of miss this replaces.
 */
/**
 * The write-reachability fixpoint, and the graph it is computed over.
 *
 * Over-approximating on purpose — see the note above.
 */

/**
 * Every member's body by name, with overloads and re-declarations accumulated
 * rather than overwritten.
 */
export function methodBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const slice of methodSlices()) {
    bodies.set(slice.name, (bodies.get(slice.name) ?? '') + slice.body);
  }
  return bodies;
}

/**
 * `name -> the members it calls on `this``, over-approximating exactly as
 * `writeClassifiedMethods` does: an edge is any `this.name(` the body mentions,
 * with no attempt to decide whether the branch holding it can be taken.
 *
 * Exported so the enforcement-safe-read guard walks the SAME graph the
 * write classification is computed over, rather than deriving a second one.
 */
export function calleeGraph(bodies: Map<string, string> = methodBodies()): Map<string, Set<string>> {
  const callees = new Map<string, Set<string>>();
  for (const [name, body] of bodies) {
    const found = new Set<string>();
    for (const call of body.matchAll(/this\.(#?[A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (bodies.has(call[1])) found.add(call[1]);
    }
    callees.set(name, found);
  }
  return callees;
}

export function writeClassifiedMethods(): Set<string> {
  const bodies = methodBodies();
  const writers = new Set<string>();
  for (const [name, body] of bodies) if (WRITE_MARKERS.test(body)) writers.add(name);
  const callees = calleeGraph(bodies);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, called] of callees) {
      if (writers.has(name)) continue;
      for (const callee of called) {
        if (writers.has(callee)) {
          writers.add(name);
          grew = true;
          break;
        }
      }
    }
  }
  return new Set([...writers].filter((name) => !name.startsWith('#')));
}

