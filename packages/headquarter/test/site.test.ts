import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escapeHtml, HQ_PAGES } from '../src/ui/render.js';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;

describe('escapeHtml', () => {
  it('escapes markup-significant characters', () => {
    expect(escapeHtml(`<script>alert("x&'y")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&amp;&#39;y&quot;)&lt;/script&gt;',
    );
  });
});

describe('buildSite', () => {
  const site = buildSite(sample);

  it('renders the full HQ information architecture', () => {
    expect([...site.keys()].sort()).toEqual(HQ_PAGES.map((page) => page.file).sort());
    for (const page of HQ_PAGES) {
      const html = site.get(page.file)!;
      expect(html).toContain('<!doctype html>');
      expect(html).toContain(`JENIFY HQ — ${page.title}`);
      // every page carries the shared navigation
      for (const other of HQ_PAGES) expect(html).toContain(`href="${other.file}"`);
    }
  });

  it('Command Center shows the five Founder sections and worker status', () => {
    const html = site.get('index.html')!;
    for (const section of ['NOW', 'DONE TODAY', 'BLOCKED', 'WAITING FOR FOUNDER', 'NEXT', 'Worker Status']) {
      expect(html).toContain(`<h2>${section}</h2>`);
    }
    expect(html).toContain('Stream 2 — Headquarter UI');
    expect(html).toContain('Fix Gemini 3.7 worker model routing'); // DONE TODAY from sample
  });

  it('Founder Approvals renders the D15 fields read-only with no action controls', () => {
    const html = site.get('approvals.html')!;
    expect(html).toContain('Universal Operator architecture proposal'); // waiting task
    expect(html).toContain('operator control plane');
    // D15 approval fields (§6b): actionDigest, expiresAt, consumedAt, decidedBy
    expect(html).toContain('Action digest');
    expect(html).toContain('3f9a1c2b4d5e6f70'); // truncated digest rendered
    expect(html).toContain('2026-08-27T05:12:23Z'); // expiresAt
    expect(html).toContain('2026-08-26T09:35:00Z'); // consumedAt
    expect(html).toContain('founder'); // decidedBy
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
  });

  it('renders the bundle provenance note on every page so samples cannot pass as authoritative', () => {
    for (const page of HQ_PAGES) {
      const html = site.get(page.file)!;
      expect(html).toContain('data-provenance');
      expect(html).toContain('reconstructed from real GitHub-visible JENIFY-OS activity');
    }
    // A bundle without a note renders no empty provenance footer.
    const bare = buildSite({ ...sample, note: undefined });
    expect(bare.get('index.html')).not.toContain('data-provenance');
  });

  it('Archive page always carries the not-original-evidence banner', () => {
    const html = site.get('archive.html')!;
    expect(html).toContain('data-archive-banner');
    expect(html).toContain('not original evidence');
    const bare = buildSite({ ...sample, note: undefined });
    expect(bare.get('archive.html')).toContain('data-archive-banner');
  });

  it('Archive page shows monthly groups, evolution, source links, and confidence flags', () => {
    const html = site.get('archive.html')!;
    expect(html).toContain('<h2>2026-08</h2>');
    expect(html).toContain('Evolution — QOS');
    expect(html).toContain('https://github.com/kiniena-github/JENIFY-OS/pull/36');
    expect(html).toContain('archive-search');
  });

  it('escapes untrusted content in rendered pages', () => {
    const hostile: HeadquarterData = {
      ...sample,
      events: [
        {
          id: 'x1',
          seq: 1,
          at: '2026-08-26T10:00:00Z',
          subjectKind: 'task',
          subjectId: 'x',
          status: 'running',
          actor: 'claude',
          summary: '<script>alert(1)</script>',
          detail: { project: '<b>P</b>', title: '<script>alert(1)</script>' },
        },
      ],
    };
    const html = buildSite(hostile).get('index.html')!;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('splits canonical chat messages into executive room and direct chats by threadId', () => {
    const executive = site.get('executive-room.html')!;
    expect(executive).toContain('Stream 2 war room open');
    expect(executive).not.toContain('dm:claude');
    const direct = site.get('direct-chats.html')!;
    expect(direct).toContain('dm:claude');
    expect(direct).toContain('isolated from operator/control-plane files');
    expect(site.get('specialists.html')).toContain('Codex');
  });
});
