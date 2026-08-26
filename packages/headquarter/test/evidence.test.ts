import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { EvidenceLog, assertNoSecretLikeContent } from '../src/operator/evidence.js';

describe('evidence log', () => {
  let db: HqDatabase;
  let log: EvidenceLog;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    log = new EvidenceLog(db);
  });

  it('appends hash-chained entries and verifies the chain', () => {
    log.append({ actor: 'claude', kind: 'test', payload: { n: 1 } });
    log.append({ actor: 'claude', kind: 'test', payload: { n: 2 } });
    log.append({ actor: 'codex', kind: 'review', payload: { n: 3 } });
    expect(log.verifyChain()).toBeNull();
    const entries = log.list();
    expect(entries).toHaveLength(3);
    expect(entries[1].prevHash).toBe(entries[0].hash);
  });

  it('detects tampering with a stored payload', () => {
    log.append({ actor: 'claude', kind: 'test', payload: { n: 1 } });
    const second = log.append({ actor: 'claude', kind: 'test', payload: { n: 2 } });
    db.prepare(`UPDATE op_evidence SET payload = ? WHERE id = ?`).run(
      JSON.stringify({ n: 999 }),
      second.id,
    );
    expect(log.verifyChain()).toBe(second.seq);
  });

  it('detects a deleted middle entry', () => {
    log.append({ actor: 'claude', kind: 'test', payload: { n: 1 } });
    const second = log.append({ actor: 'claude', kind: 'test', payload: { n: 2 } });
    log.append({ actor: 'claude', kind: 'test', payload: { n: 3 } });
    db.prepare(`DELETE FROM op_evidence WHERE id = ?`).run(second.id);
    expect(log.verifyChain()).not.toBeNull();
  });

  it('refuses secret-like payloads', () => {
    expect(() =>
      log.append({ actor: 'claude', kind: 'test', payload: { config: 'password = hunter2secret' } }),
    ).toThrow(/secret-like/);
    expect(() => assertNoSecretLikeContent({ ok: 'plain text' })).not.toThrow();
  });
});
