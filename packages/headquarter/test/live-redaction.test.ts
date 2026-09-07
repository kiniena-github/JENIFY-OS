/**
 * Browser-safety guard (issue #200).
 *
 * These are the tests that make "no secret reaches the browser" a mechanical
 * property rather than a promise. They deliberately include the two cases
 * that matter most in practice: a credential smuggled in under an innocent
 * key (caught by shape), and a credential-shaped FIELD NAME carrying a value
 * (caught by name, whatever the value looks like).
 */

import { describe, expect, it } from 'vitest';
import {
  assertBrowserSafe,
  assertNoFabricatedFields,
  BrowserSafetyError,
  SECRET_SHAPES_COVERED,
  SECRET_SHAPES_NOT_COVERED,
} from '../src/live/redaction.js';

describe('assertBrowserSafe — key rule', () => {
  it('refuses a credential-named field carrying any value', () => {
    for (const key of ['apiKey', 'api_key', 'secret', 'password', 'accessToken', 'clientSecret', 'privateKey']) {
      expect(() => assertBrowserSafe({ [key]: 'anything-at-all' })).toThrow(BrowserSafetyError);
    }
  });

  it('names the offending path so the leak can be found, not just blocked', () => {
    try {
      assertBrowserSafe({ connections: [{ id: 'github', apiKey: 'abc12345' }] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BrowserSafetyError).path).toBe('snapshot.connections[0].apiKey');
    }
  });

  it('allows a credential-named field that carries no value', () => {
    expect(() => assertBrowserSafe({ token: null, apiKey: '', secret: undefined })).not.toThrow();
  });

  it('allows fact NAMES, because presence is not a secret', () => {
    // This asymmetry is the whole point of the presence-not-value convention:
    // saying CLAUDE_ROUTINE_TOKEN is absent leaks nothing.
    expect(() =>
      assertBrowserSafe({
        missingFacts: ['CLAUDE_ROUTINE_TOKEN', 'GEMINI_API_KEY', 'SUPABASE_ANON_KEY'],
        observedFacts: ['CODEX_CLI_PATH'],
      }),
    ).not.toThrow();
  });
});

describe('assertBrowserSafe — value rule', () => {
  const credentials: [string, string][] = [
    ['OpenAI key', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'],
    ['Google API key', 'AIzaSyA0123456789abcdefghijklmnopqrstuv'],
    ['Slack token', 'xoxb-123456789012-abcdefghijkl'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----'],
    ['Authorization header', 'Bearer abcdefghijklmnopqrstuvwxyz123456'],
  ];

  it.each(credentials)('refuses a %s wherever it appears in the tree', (_label, value) => {
    expect(() => assertBrowserSafe({ a: { b: [{ blockReason: value }] } })).toThrow(BrowserSafetyError);
  });

  it('refuses a credential hidden under an innocent-looking key', () => {
    // The key rule cannot help here; only the shape rule catches it.
    expect(() => assertBrowserSafe({ summary: 'deploy used ghp_abcdefghijklmnopqrstuvwxyz012' })).toThrow(
      BrowserSafetyError,
    );
  });

  it('keeps allowing the hashes, digests and ids HQ legitimately renders', () => {
    // A generic high-entropy rule would reject all of these, which is why the
    // value rule is shape-based instead.
    expect(() =>
      assertBrowserSafe({
        actionDigest: '3f9a1c2b4d5e6f7081920a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
        claimNonce: 'b6b0f0a2c9d84e2fb1c7a3e5d9f04c18',
        taskId: '9f2c6c1e-6d64-4c0a-a5c7-6a0f1c2d3e4b',
        idempotencyKey: 'direct-order:8f14e45fceea167a5a36dedd4bea2543',
      }),
    ).not.toThrow();
  });
});

describe('assertNoFabricatedFields', () => {
  it('refuses metrics the control plane does not record', () => {
    for (const field of ['cost', 'costUsd', 'tokens', 'eta', 'sentiment', 'progressPercent']) {
      expect(() => assertNoFabricatedFields({ card: { [field]: 42 } })).toThrow(BrowserSafetyError);
    }
  });

  it('leaves a vendor-advertised model property alone', () => {
    // contextWindowTokens describes the model, it does not measure a run.
    expect(() => assertNoFabricatedFields({ model: { contextWindowTokens: 200000 } })).not.toThrow();
  });
});

/**
 * Wave 5 review, correction cycle 2 — LOW 3.
 *
 * The Phase 14 document said the facade scan was pinned "against six real
 * credential shapes — each refused at the facade". A reviewer supplied a
 * seventh, an AWS access key id, and it was ALLOWED:
 *
 *     "AKIAIOSFODNN7EXAMPLE" -> ALLOWED
 *
 * That was a pre-existing scope limit of `SECRET_VALUE_PATTERNS`, not a Wave 5
 * regression — but an undisclosed scope limit on a safety scan is the limit
 * that gets relied on. The shape is now covered, and the SCOPE in both
 * directions is published as data so no document has to say "credential
 * shapes" and quietly mean "these twelve".
 */
describe('the value rule states its own scope', () => {
  it('now refuses an AWS long-term access key id', () => {
    expect(() => assertBrowserSafe({ note: 'use AKIAIOSFODNN7EXAMPLE for the bucket' })).toThrow(
      BrowserSafetyError,
    );
    expect(() => assertBrowserSafe({ deploy: { region: 'AKIA1234567890ABCDEF' } })).toThrow(
      BrowserSafetyError,
    );
  });

  it('costs no false positive on ordinary text, ids or all-caps prose', () => {
    // `AKIA` is only a credential when followed by exactly 16 upper-case
    // alphanumerics on a word boundary. Everything here is left alone.
    expect(() =>
      assertBrowserSafe({
        a: 'AKIA',
        b: 'AKIASHORT',
        c: 'THE AKIA PREFIX IS AN AWS CONVENTION',
        d: 'akiaiosfodnn7example',
        e: 'ASIA PACIFIC REGION',
        f: 'REGION-AKIA-2026',
      }),
    ).not.toThrow();
  });

  it('publishes what it does NOT cover, rather than implying credentials generally', () => {
    expect(SECRET_SHAPES_COVERED).toContain('AWS long-term access key id (AKIA + 16)');
    expect(SECRET_SHAPES_COVERED.length).toBe(12);
    // The honest complement. The AWS SECRET access key is the important entry:
    // 40 base64 characters with no prefix is shape-indistinguishable from the
    // digests and nonces HQ legitimately renders, so no shape rule can catch
    // it without breaking the snapshot.
    expect(SECRET_SHAPES_NOT_COVERED.some((shape) => shape.includes('AWS secret access key'))).toBe(
      true,
    );
    expect(() => assertBrowserSafe({ note: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' })).not.toThrow();
    // ...but it IS caught under a separator-delimited credential field name,
    // which is the other rule and the one that actually protects a real
    // payload.
    expect(() =>
      assertBrowserSafe({ aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }),
    ).toThrow(BrowserSafetyError);
  });

  it('states the key rule’s own limit: it matches separator-delimited names', () => {
    // Found while pinning the value rule's scope, and recorded rather than
    // quietly worked around. `SECRET_KEY_PATTERN` anchors on `_`/`-`
    // boundaries plus a short enumerated set of camelCase forms (`apiKey`,
    // `accessToken`, `privateKey`, `clientSecret`), so an unenumerated
    // camelCase compound is NOT matched by name. It is still caught whenever
    // its value has a recognised shape; a shapeless secret under such a name
    // is not. Widening the pattern is a separate, testable change — this test
    // exists so the limit cannot be discovered again as a surprise.
    expect(() => assertBrowserSafe({ apiKey: 'x' })).toThrow(BrowserSafetyError);
    expect(() => assertBrowserSafe({ clientSecret: 'x' })).toThrow(BrowserSafetyError);
    expect(() => assertBrowserSafe({ secretAccessKey: 'shapeless-but-secret' })).not.toThrow();
    expect(
      SECRET_SHAPES_NOT_COVERED.some((shape) => shape.includes('camelCase')),
    ).toBe(true);
  });
});
