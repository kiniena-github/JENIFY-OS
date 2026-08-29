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

/**
 * Run the genuine CLI (not a reimplementation: a regression in build-site.ts
 * itself must fail here) and return every artefact it wrote.
 *
 * `env` defaults to the inherited environment; the leak scan below re-runs
 * the build with a scrubbed environment as a counterfactual control.
 */
function runBuild(env?: NodeJS.ProcessEnv): Map<string, string> {
  execFileSync(process.execPath, [tsxCli, path.join(packageRoot, 'src', 'cli', 'build-site.ts')], {
    cwd: packageRoot,
    stdio: 'pipe',
    ...(env ? { env } : {}),
  });
  return new Map(
    readdirSync(siteDir).map((file) => [file, readFileSync(path.join(siteDir, file), 'utf8')]),
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count += 1;
  return count;
}

describe('the real site build', () => {
  let artifacts: Map<string, string>;

  beforeAll(() => {
    artifacts = runBuild();
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

    // First pass: which suspicious values appear in which artefact at all?
    const hits: Array<{ file: string; name: string; value: string }> = [];
    for (const [file, content] of artifacts) {
      for (const [name, value] of suspicious) {
        if (content.includes(value!)) hits.push({ file, name, value: value! });
      }
    }
    if (hits.length === 0) return;

    // Counterfactual control (the provenance rule, decided on issue #200):
    // a hit alone does not prove environment egress, because committed build
    // inputs can legitimately contain the same string as a generic CI
    // variable — on the CI runner, $GITHUB_REPOSITORY_OWNER equals the
    // repository owner that the committed sample bundle's public
    // github.com ref URLs already spell out. So re-run the SAME CLI with a
    // scrubbed environment and compare per-file occurrence COUNTS:
    //
    //   - a value the environment contributed cannot appear as often (or at
    //     all) when the environment is empty → real egress → FAIL;
    //   - a value whose every occurrence survives an empty environment was
    //     produced from committed inputs alone → the environment provably
    //     was not the source → not egress.
    //
    // Threat-model boundary, explicitly: this test detects values FLOWING
    // FROM THE BUILD ENVIRONMENT into a served artefact — host paths,
    // account names, tokens, CI metadata. It deliberately does NOT detect a
    // secret that has been committed into the build inputs themselves: such
    // a value appears with the environment empty, so no environment-side
    // scan can attribute it to the environment. That class is a repository
    // hygiene incident (never commit secrets; secret scanning), not build
    // egress, and pretending this test covered it would be false comfort.
    // No variable is exempted by NAME — GITHUB_* included: if the build ever
    // starts copying $GITHUB_REPOSITORY_OWNER's value into a page, the
    // occurrence count rises above the scrubbed build's and this fails.
    //
    // The scrubbed environment is as close to empty as the OS allows
    // (Windows needs SystemRoot to spawn processes). A kept variable must
    // not itself carry a flagged value, or the control would be unsound.
    const keep = process.platform === 'win32' ? ['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR'] : [];
    const scrubbedEnv: NodeJS.ProcessEnv = {};
    for (const name of keep) {
      const value = process.env[name];
      if (value != null && !hits.some((hit) => value.includes(hit.value))) {
        scrubbedEnv[name] = value;
      }
    }
    const scrubbed = runBuild(scrubbedEnv);

    for (const { file, name, value } of hits) {
      const withEnv = countOccurrences(artifacts.get(file)!, value);
      const withoutEnv = countOccurrences(scrubbed.get(file) ?? '', value);
      expect(
        withEnv,
        `${file} contains the value of $${name} ${withEnv}× with the environment present but ` +
          `only ${withoutEnv}× with it scrubbed — the difference came from the environment`,
      ).toBeLessThanOrEqual(withoutEnv);
    }
  });

  it('contains nothing credential-shaped, wherever it came from', () => {
    // Complement to the environment-side scan above, closing its declared
    // blind spot from the artefact side: a token-shaped string is forbidden
    // in a served artefact REGARDLESS of provenance — environment, committed
    // input, or renderer bug. High-signal, well-known prefixes only; this is
    // not a general secret scanner (that runs on the repository, not here).
    const credentialShaped: Array<[string, RegExp]> = [
      ['GitHub token', /\bgh[opusr]_[A-Za-z0-9]{36}/],
      ['GitHub fine-grained PAT', /\bgithub_pat_[A-Za-z0-9_]{22,}/],
      ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
      ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
      ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}/],
      ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/],
    ];
    for (const [file, content] of artifacts) {
      for (const [label, pattern] of credentialShaped) {
        expect(pattern.test(content), `${file} contains a ${label} (${pattern})`).toBe(false);
      }
    }
  });
});
