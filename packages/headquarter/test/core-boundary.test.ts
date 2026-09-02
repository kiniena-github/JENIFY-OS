/**
 * The core boundary (Phase 2, Stage 0).
 *
 * `packages/headquarter` is the JENIFY HQ product core. Phase 2 will grow a
 * separate HTTP host, a browser/3D client and eventually a desktop shell around
 * it, and every one of those is a CONSUMER of this package. The property that
 * makes that possible — and that the Phase 2 inspection found already true —
 * is that the core depends on nothing above it:
 *
 *   · it imports no sibling workspace package;
 *   · it never reaches outside its own directory by relative path;
 *   · its runtime dependencies are a short, declared list.
 *
 * None of that was enforced anywhere. It held by discipline, which is exactly
 * the kind of property that quietly stops holding during a restructure. This
 * suite pins it BEFORE the restructure starts, so a violation fails here rather
 * than being discovered later as "HQ can't run without the tenant server".
 *
 * These are architecture tests. They assert on the shipped source text, not on
 * a description of it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(packageRoot, 'src');

/** Every .ts file under src/, recursively. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

/**
 * Strip comments before looking for imports.
 *
 * Load-bearing: this package documents itself heavily and several files
 * legitimately NAME sibling packages in prose ("the host adapts its own
 * framework to it (`@factoryos/server`'s ...)"). A naive text search reports
 * those as dependencies and the suite becomes a liar. Only real import
 * statements count.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Module specifiers actually imported (static imports, re-exports, dynamic).
 *
 * The static patterns are anchored to the start of a line, which matters more
 * than it looks: a bare `/from ['"].../` also matches ENGLISH inside a string
 * literal, and this package writes a lot of English. `render.ts` really does
 * contain `'... not from ' +`, and an unanchored matcher reported it as a
 * dependency named " +". Anchoring keeps the suite honest about what an import
 * is; the binding list is matched with `[^'"]` so a multi-line `import { ... }`
 * still resolves while a quote can never be crossed.
 */
function importedModules(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];
  const patterns = [
    /^\s*(?:import|export)\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

const files = sourceFiles(srcRoot);

/** Declared runtime dependencies, from the manifest rather than from memory. */
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const declaredRuntimeDeps = Object.keys(manifest.dependencies ?? {});

describe('the HQ core depends on nothing above it (Phase 2, Stage 0)', () => {
  it('finds a source tree to check at all', () => {
    // Guards the whole suite: a broken walk would make every other test pass
    // vacuously, which is the classic way an architecture test stops working.
    expect(files.length).toBeGreaterThan(100);
  });

  it('imports NO sibling workspace package', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        // Its own name would be just as wrong: the core must not round-trip
        // through its own public entry points.
        if (specifier.startsWith('@factoryos/')) {
          offenders.push(`${relative(packageRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders, 'the core must not import any workspace package').toEqual([]);
  });

  it('never escapes its own directory by relative path', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(srcRoot + sep)) {
          offenders.push(`${relative(packageRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders, 'a relative import left packages/headquarter/src').toEqual([]);
  });

  it('imports only node builtins and its own declared runtime dependencies', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        // Bare specifiers resolve to a package; scoped names carry two segments.
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (!declaredRuntimeDeps.includes(packageName)) {
          offenders.push(`${relative(packageRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(
      offenders,
      'an undeclared runtime dependency would not install for a consumer of the core',
    ).toEqual([]);
  });

  it('keeps that runtime dependency list short enough to host anywhere', () => {
    // Not style. Every runtime dependency is something a desktop shell and a
    // hosted runtime must both be able to load. `better-sqlite3` is already a
    // native module and is already a known Phase 2/Stage 3 constraint; growing
    // this list quietly would add more of them.
    expect(declaredRuntimeDeps.sort()).toEqual(['better-sqlite3', 'uuid']);
  });

  it('confines native-module use to the store, so persistence stays swappable', () => {
    // Stage 3 has to put a durable adapter behind the store interface. That is
    // only cheap while exactly one module knows the driver exists.
    const importers = files
      .filter((file) => importedModules(readFileSync(file, 'utf8')).includes('better-sqlite3'))
      .map((file) => relative(packageRoot, file).split(sep).join('/'));
    expect(importers).toEqual(['src/store/db.ts']);
  });
});
