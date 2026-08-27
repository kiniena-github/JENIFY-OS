/**
 * Hostile security regression tests for the connector lane (issues #123/#140).
 *
 * These attack the connector boundary directly: secret material in payloads,
 * XSS-shaped locators, credential-bearing configs, attempts to widen scope
 * beyond read, and attempts to use a connector that does not exist yet.
 */
import { describe, expect, it } from 'vitest';
import {
  assertNoCredentialFields,
  assertNoSecretMaterial,
  findSecretLike,
  redactSecrets,
  sanitizeLocator,
  sanitizeText,
} from '../src/connectors/safety.js';
import { normalizeGitHubItem } from '../src/connectors/github.js';
import { normalizeDriveFile } from '../src/connectors/drive.js';
import { createConnectorIndex, runConnectorSync } from '../src/connectors/sync.js';
import {
  CONNECTOR_REGISTRY,
  assertConnectorImplemented,
  implementedConnectors,
  plannedConnectors,
} from '../src/connectors/registry.js';
import { ConnectorPolicyError, assertReadOnlyScope } from '../src/connectors/types.js';

const NOW = '2026-08-27T12:00:00Z';

describe('secret material never gets serialized', () => {
  const SECRETS = [
    'ghp_0123456789abcdefghijklmn',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'ya29.a0AfH6SMBexampleexample',
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'Bearer abcdefghijklmnopqrstuvwxyz012345',
    'api_key: 8f3a9c2b1d4e5f60',
    '-----BEGIN RSA PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk',
  ];

  it.each(SECRETS)('detects %s as secret-like', (secret) => {
    expect(findSecretLike(secret).length).toBeGreaterThan(0);
  });

  it.each(SECRETS)('redacts %s out of sanitized text', (secret) => {
    const sanitized = sanitizeText(`leaked ${secret} here`);
    expect(sanitized).toContain('[redacted]');
    expect(findSecretLike(sanitized)).toEqual([]);
  });

  it('refuses to serialize a payload carrying a token', () => {
    expect(() => assertNoSecretMaterial('index entry', { note: 'ghp_0123456789abcdefghijklmn' })).toThrow(
      /secret-like content/,
    );
  });

  it('scrubs a token smuggled through a GitHub issue title', () => {
    const result = normalizeGitHubItem(
      { kind: 'issue', number: 1, title: 'deploy with ghp_0123456789abcdefghijklmn now' },
      NOW,
      { repo: 'kiniena-github/JENIFY-OS' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.title).not.toMatch(/ghp_/);
    expect(() => assertNoSecretMaterial('observation', result.item)).not.toThrow();
  });

  it('scrubs a token smuggled through a Drive file name', () => {
    const result = normalizeDriveFile(
      { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', name: 'creds ya29.a0AfH6SMBexampleexample.txt' },
      NOW,
      { folderId: 'root', authState: 'authorized' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.title).not.toMatch(/ya29\./);
  });

  it('redacts secrets out of connector failure messages', async () => {
    const outcome = await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index: createConnectorIndex('github'),
      fetchPage: async () => {
        throw new Error('request failed with Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
      },
      normalize: () => ({ ok: false, reason: 'unused' }),
      now: NOW,
    });
    expect(outcome.status).toBe('outcome_unknown');
    expect(outcome.problems[0]?.message).toContain('[redacted]');
    expect(findSecretLike(JSON.stringify(outcome))).toEqual([]);
  });

  it('rejects credential-like config fields at any nesting depth', () => {
    expect(() => assertNoCredentialFields('cfg', { repo: 'a/b' })).not.toThrow();
    expect(() => assertNoCredentialFields('cfg', { auth: { access_token: 'x' } })).toThrow(/credential-like field/);
    expect(() => assertNoCredentialFields('cfg', { nested: { deep: { client_secret: 'x' } } })).toThrow(
      /credential-like field/,
    );
  });
});

describe('link safety / XSS', () => {
  const HOSTILE = [
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'http://insecure.example.com/evidence',
  ];

  it.each(HOSTILE)('refuses to mark %s link-safe', (locator) => {
    expect(sanitizeLocator(locator).linkSafe).toBe(false);
  });

  it('accepts a plain https evidence URL', () => {
    const check = sanitizeLocator('https://github.com/kiniena-github/JENIFY-OS/issues/140');
    expect(check).toMatchObject({ linkSafe: true });
  });

  it('strips embedded credentials from a URL and refuses to link it', () => {
    const check = sanitizeLocator('https://user:hunter2@github.com/kiniena-github/JENIFY-OS');
    expect(check.linkSafe).toBe(false);
    expect(check.locator).not.toContain('hunter2');
    expect(check.note).toBe('locator_had_embedded_credentials');
  });

  it('keeps non-URL locators (repo paths, Drive ids) as inert text', () => {
    const check = sanitizeLocator('packages/headquarter/src/connectors/github.ts');
    expect(check).toMatchObject({ linkSafe: false, note: 'locator_not_absolute_url' });
    expect(check.locator).toBe('packages/headquarter/src/connectors/github.ts');
  });

  it('treats a missing or non-string locator as unusable rather than empty-but-fine', () => {
    expect(sanitizeLocator(undefined)).toMatchObject({ locator: '', linkSafe: false, note: 'locator_missing' });
    expect(sanitizeLocator({ href: 'https://x' })).toMatchObject({ linkSafe: false });
  });

  it('never fabricates a link out of hostile GitHub or Drive metadata', () => {
    for (const hostile of HOSTILE) {
      const gh = normalizeGitHubItem({ kind: 'issue', number: 3, html_url: hostile }, NOW, {
        repo: 'kiniena-github/JENIFY-OS',
      });
      expect(gh.ok).toBe(true);
      if (gh.ok) {
        expect(gh.item.provenance.locator).toBe('https://github.com/kiniena-github/JENIFY-OS/issues/3');
      }
    }
  });

  it('preserves script-shaped text verbatim for the render layer to escape', () => {
    // Silently stripping tags would corrupt real titles; escaping is the UI's
    // job. What matters here is that it never becomes a link.
    expect(sanitizeText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
    expect(sanitizeLocator('<script>alert(1)</script>').linkSafe).toBe(false);
  });
});

describe('least privilege', () => {
  it('refuses any scope other than read', () => {
    expect(() => assertReadOnlyScope('read')).not.toThrow();
    for (const scope of ['write', 'delete', 'admin', '', null, undefined]) {
      expect(() => assertReadOnlyScope(scope)).toThrow(ConnectorPolicyError);
    }
  });

  it('blocks a sync attempted with a non-read scope before any fetch', async () => {
    let fetched = false;
    const outcome = await runConnectorSync({
      connectorId: 'github',
      scope: 'write' as never,
      index: createConnectorIndex('github'),
      fetchPage: async () => {
        fetched = true;
        return { ok: true, page: { items: [], nextCursor: null } };
      },
      normalize: () => ({ ok: false, reason: 'unused' }),
      now: NOW,
    });

    expect(fetched).toBe(false);
    expect(outcome.status).toBe('blocked');
    expect(outcome.problems[0]?.code).toBe('blocked_by_policy');
    expect(outcome.counts.observed).toBe(0);
  });

  it('declares every registered connector read-only', () => {
    for (const descriptor of CONNECTOR_REGISTRY) {
      expect(descriptor.scope).toBe('read');
    }
  });
});

describe('extension points do not pretend to work', () => {
  it('implements exactly github and drive in this lane', () => {
    expect(implementedConnectors().map((d) => d.id).sort()).toEqual(['drive', 'github']);
  });

  it('declares the future connectors without implementing them', () => {
    expect(plannedConnectors().map((d) => d.id).sort()).toEqual([
      'calendar',
      'gmail',
      'jenify-products',
      'jenify-web',
      'media',
    ]);
    for (const descriptor of plannedConnectors()) {
      expect(descriptor.nativeKinds).toEqual([]);
    }
  });

  it('refuses a planned or unknown connector loudly instead of returning nothing', () => {
    expect(() => assertConnectorImplemented('github')).not.toThrow();
    expect(() => assertConnectorImplemented('gmail')).toThrow(/planned extension point/);
    expect(() => assertConnectorImplemented('slack')).toThrow(/Unknown connector/);
    try {
      assertConnectorImplemented('gmail');
    } catch (error) {
      expect((error as ConnectorPolicyError).code).toBe('connector_not_implemented');
    }
  });
});
