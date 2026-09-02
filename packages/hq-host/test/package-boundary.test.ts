/**
 * `@factoryos/hq-host` must not reacquire the tenant platform (Phase 2, Stage 1).
 *
 * The whole value of this package is negative: it is the HQ HTTP surface with
 * the JENIFY OS server removed. That property is one careless import away from
 * being lost, and losing it would be silent — everything would still compile and
 * pass, and only a later attempt to run HQ on its own would reveal it.
 *
 * So it is asserted here, the same way `packages/headquarter/test/
 * core-boundary.test.ts` asserts it one layer down.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(packageRoot, 'src');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

function importedModules(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const specifiers: string[] = [];
  for (const pattern of [
    /^\s*(?:import|export)\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

const files = sourceFiles(srcRoot);
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};
const declared = Object.keys(manifest.dependencies ?? {});

describe('hq-host carries HQ, not the tenant platform', () => {
  it('has a source tree to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('never imports @factoryos/server', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        if (specifier === '@factoryos/server' || specifier.startsWith('@factoryos/server/')) {
          offenders.push(relative(packageRoot, file));
        }
      }
    }
    expect(
      offenders,
      'importing the tenant server here would undo the entire point of this package',
    ).toEqual([]);
  });

  it('imports only node builtins and its declared dependencies', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (!declared.includes(name)) offenders.push(`${relative(packageRoot, file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares only the core, Fastify and its static plugin', () => {
    expect(declared.sort()).toEqual(['@factoryos/headquarter', '@fastify/static', 'fastify']);
  });

  it('implements no credential store of its own', () => {
    // HQ has no sign-in. A password hash, a token mint or a session table
    // appearing in this package would mean one had been invented during the
    // split — the exact thing the 2026-08-28 Founder decision forbids.
    const forbidden = /\b(scrypt|bcrypt|argon2|pbkdf2|createHmac|randomBytes)\b/;
    const offenders = files.filter((file) => forbidden.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(packageRoot, f))).toEqual([]);
  });
});
