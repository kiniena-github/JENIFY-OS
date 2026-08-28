/**
 * The built site artefact leaks nothing about the build machine
 * (issue #200, integration lane — coordinator finding on `hq-snapshot.json`).
 *
 * `build-site.ts` used to interpolate the resolved absolute bundle path into
 * three provenance `source` fields, so the browser-served snapshot carried
 * the build machine's checkout path — host filesystem layout and account
 * name — and the artefact differed byte-for-byte per checkout location,
 * breaking reproducible builds.
 *
 * This suite closes the CLASS, not the instance: it runs the REAL CLI (the
 * same entry `npm run build:site` invokes) and scans every artefact it wrote
 * for (a) any absolute filesystem path, this checkout's in particular, and
 * (b) any environment variable value that travelled verbatim into the output
 * — the check that caught the original finding.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { portableSourceLabel } from '../src/live/snapshot.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const siteDir = path.join(packageRoot, 'dist', 'site');

describe('portableSourceLabel', () => {
  it('turns a path inside the repository into a repo-relative posix path', () => {
    const inside = path.join(repoRoot, 'packages', 'headquarter', 'sample-data', 'hq-sample.json');
    expect(portableSourceLabel(inside, repoRoot)).toBe(
      'packages/headquarter/sample-data/hq-sample.json',
    );
  });

  it('reduces a path OUTSIDE the repository to its basename — the rest is host information', () => {
    expect(portableSourceLabel('/home/someone/private/bundle.json', repoRoot)).toBe('bundle.json');
    expect(portableSourceLabel(path.join(repoRoot, '..', 'elsewhere', 'x.json'), repoRoot)).toBe(
      'x.json',
    );
  });

  it('never returns an absolute path, whatever it is handed', () => {
    for (const input of [repoRoot, '/', '/etc/passwd', path.join(repoRoot, 'a', '..', 'b.json')]) {
      const label = portableSourceLabel(input, repoRoot);
      expect(path.isAbsolute(label), input).toBe(false);
      expect(label.startsWith('..'), input).toBe(false);
    }
  });
});

describe('the real site build', () => {
  let artifacts: Map<string, string>;

  beforeAll(() => {
    // The genuine CLI, not a reimplementation: a regression in build-site.ts
    // itself must fail here.
    execFileSync(process.execPath, [tsxCli, path.join(packageRoot, 'src', 'cli', 'build-site.ts')], {
      cwd: packageRoot,
      stdio: 'pipe',
    });
    artifacts = new Map(
      readdirSync(siteDir).map((file) => [file, readFileSync(path.join(siteDir, file), 'utf8')]),
    );
  }, 120_000);

  it('produced the nine pages and the snapshot', () => {
    expect(artifacts.size).toBe(10);
    expect(artifacts.has('hq-snapshot.json')).toBe(true);
    expect(artifacts.has('index.html')).toBe(true);
  });

  it('attributes the bundle repo-relatively in the snapshot provenance', () => {
    const snapshot = JSON.parse(artifacts.get('hq-snapshot.json')!) as Record<string, unknown>;
    const sources: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value != null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (key === 'source' && typeof child === 'string') sources.push(child);
          walk(child);
        }
      }
    };
    walk(snapshot);
    expect(sources.length).toBeGreaterThan(0);
    expect(
      sources.some((source) => source.includes('packages/headquarter/sample-data/hq-sample.json')),
    ).toBe(true);
  });

  it('embeds no absolute filesystem path in any served artefact', () => {
    // The checkout path of THIS build, and the generic roots any build
    // machine would leak. `\b` boundaries are wrong for paths, so the roots
    // are matched as plain substrings — the sample bundle and the renderers
    // are known clean of them (verified before this test existed).
    const forbidden = [repoRoot, '/home/', '/root/', '/Users/', '/tmp/', '/var/', '/opt/'];
    for (const [file, content] of artifacts) {
      for (const marker of forbidden) {
        expect(content.includes(marker), `${file} contains ${marker}`).toBe(false);
      }
    }
  });

  it('carries no environment variable value verbatim into the output', () => {
    // The scan that caught the original finding. Skipped, deliberately:
    // values that are short, contain spaces (natural language), or are single
    // plain words ('production', 'true') — they collide with prose without
    // identifying the machine — and the npm_package_* manifest mirror, whose
    // values are COMMITTED package.json content (npm_package_name is
    // '@factoryos/headquarter', which the composer's CLI instructions
    // legitimately print). Machine-describing npm vars (npm_execpath,
    // npm_config_cache, …) are NOT npm_package_* and stay in scope.
    const suspicious = Object.entries(process.env).filter(
      ([name, value]) =>
        typeof value === 'string' &&
        value.length >= 10 &&
        !value.includes(' ') &&
        !/^[A-Za-z]+$/.test(value) &&
        !name.startsWith('npm_package_'),
    );
    expect(suspicious.length).toBeGreaterThan(0);
    for (const [file, content] of artifacts) {
      for (const [name, value] of suspicious) {
        expect(content.includes(value!), `${file} contains the value of $${name}`).toBe(false);
      }
    }
  });
});
