import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escapeHtml, HQ_PAGES } from '../src/hq/render.js';
import { buildSite, type HeadquarterData } from '../src/hq/site.js';

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

  it('Founder Approvals lists only needs_approval tasks and stays read-only', () => {
    const html = site.get('approvals.html')!;
    expect(html).toContain('Universal Operator architecture proposal');
    expect(html).toContain('operator control layer');
    expect(html).not.toContain('<button');
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
          taskId: 'x',
          project: '<b>P</b>',
          title: '<script>alert(1)</script>',
          worker: 'claude',
          status: 'running',
          occurredAt: '2026-08-26T10:00:00Z',
        },
      ],
    };
    const html = buildSite(hostile).get('index.html')!;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('Direct chats and executive room render transcripts from the contract', () => {
    expect(site.get('direct-chats.html')).toContain('sample transcript');
    expect(site.get('executive-room.html')).toContain('Stream 2 war room open');
    expect(site.get('specialists.html')).toContain('Codex');
  });
});
