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

/**
 * Comments out, code only.
 *
 * Needed by every scan here, not just the import one: this package documents
 * WHY it does not use a password KDF, so the words `scrypt` and `password_hash`
 * legitimately appear in prose. A scan that reads comments reports the
 * explanation as the violation — which is exactly what happened the first time
 * the rule below was written.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function importedModules(source: string): string[] {
  const code = stripComments(source);
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

  it('declares only the core, Fastify and its cookie/static plugins', () => {
    expect(declared.sort()).toEqual([
      '@factoryos/headquarter',
      '@fastify/cookie',
      '@fastify/static',
      'fastify',
    ]);
  });

  /**
   * HQ still holds no passwords (Founder decision 2026-08-28, reaffirmed in the
   * Gate A decision of 2026-09-02: *"HQ must NOT create or store its own
   * passwords... The HQ session store is not a second identity/password
   * database"*).
   *
   * Stage 1 enforced this by banning every crypto primitive outright, which
   * worked only while this package did no crypto at all. A-4 requires it to
   * mint session tokens and hash them for storage, so the Founder explicitly
   * authorised narrowing this rule "only as required to allow secure random
   * session-token generation".
   *
   * The narrowing is exactly that, and no wider:
   *
   *   ALLOWED   randomBytes      minting a session token
   *             createHash       storing a digest of it instead of the token
   *             timingSafeEqual  comparing the service secret without a leak
   *
   *   FORBIDDEN scrypt bcrypt argon2 pbkdf2 — the password KDFs. Their whole
   *             purpose is to be slow enough to resist guessing a HUMAN secret,
   *             so one appearing here would mean a password store had arrived.
   *
   * The distinction is real, not cosmetic: a 32-byte CSPRNG token has no
   * guessing attack for a slow KDF to defend, and a slow KDF on every request
   * would be a denial-of-service surface rather than a protection.
   */
  it('implements no password store of its own', () => {
    const passwordKdf = /\b(scrypt|bcrypt|argon2|pbkdf2)\b/;
    const offenders = files.filter((file) => passwordKdf.test(stripComments(readFileSync(file, 'utf8'))));
    expect(
      offenders.map((f) => relative(packageRoot, f)),
      'a password-hashing KDF here would mean HQ had grown a second credential system',
    ).toEqual([]);
  });

  it('never reads a password field from its own storage', () => {
    // Complements the KDF ban: HQ may RELAY a step-up password to the identity
    // host over the back channel, but must never persist or look one up.
    const persisted = /\b(password_hash|passwordHash|credentials?_hash)\b/;
    const offenders = files.filter((file) => persisted.test(stripComments(readFileSync(file, 'utf8'))));
    expect(offenders.map((f) => relative(packageRoot, f))).toEqual([]);
  });
});
