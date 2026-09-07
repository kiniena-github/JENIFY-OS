/**
 * Phase 11 pure core: the vocabulary, the source registry, query
 * normalization, the deterministic order, the retrieval adapter boundary and
 * the answer composer — all without a database.
 *
 * These are the properties the facade suites then prove against real canonical
 * machinery. Anything provable here is proved here, because a pure test cannot
 * be satisfied by an accident of fixture data.
 */

import { describe, expect, it } from 'vitest';
import {
  ANSWER_LIMITATIONS,
  ANSWER_STATES,
  ANSWER_UNKNOWN_REASONS,
  ASK_CITATION_LIMIT,
  LEXICAL_RETRIEVAL_ADAPTER,
  MAX_QUERY_TERMS,
  MAX_SNIPPET_LENGTH,
  QUERY_STOPWORDS,
  RETRIEVAL_MODES,
  RETRIEVAL_UNAVAILABLE_REASONS,
  SEARCH_READ_LIMIT,
  SEARCH_SOURCES,
  SEARCH_SOURCE_REGISTRY,
  SEMANTIC_RETRIEVAL_ADAPTERS,
  TERM_MATCHES,
  asArchiveProjection,
  assembleAnswer,
  composeAnswerText,
  matchedTermsOf,
  normalizeSearchQuery,
  orderDocuments,
  resolveRetrievalAdapter,
  runCompanySearch,
  searchDocumentView,
  searchSourceDescriptor,
  snippetOf,
  sourceStatuses,
  type SearchCorpus,
  type SearchDocument,
  type SearchSourceId,
} from '../src/application/search-command.js';
import { TRUTH_STATES } from '../src/application/truth-command.js';

function doc(over: Partial<SearchDocument> & { entityId: string; source: SearchSourceId }): SearchDocument {
  return {
    id: `${over.source}:${over.entityId}`,
    table: searchSourceDescriptor(over.source).table,
    title: 'A title',
    body: 'A body',
    status: 'CURRENT',
    lifecycle: 'not_applicable',
    truthState: null,
    privacy: 'internal',
    at: '2026-09-01T00:00:00.000Z',
    project: '',
    tags: [],
    evidenceRefs: [],
    refs: [],
    ...over,
  };
}

function corpusOf(documents: SearchDocument[]): SearchCorpus {
  return {
    documents,
    sources: SEARCH_SOURCES.map((id) => ({ id, storePresent: true })),
    builtAt: '2026-09-07T00:00:00.000Z',
  };
}

function runSearch(documents: SearchDocument[], text: string, includeFounderOnly = true) {
  const normalized = normalizeSearchQuery({ text });
  if (!normalized.ok) throw new Error(normalized.message);
  return runCompanySearch({
    corpus: corpusOf(documents),
    query: { text },
    terms: normalized.terms,
    ignoredTerms: normalized.ignoredTerms,
    criteria: normalized.criteria,
    includeFounderOnly,
    now: '2026-09-07T00:00:00.000Z',
  });
}

describe('the source registry is the whole vocabulary, and it is total', () => {
  it('describes exactly the declared sources, once each, with a real table', () => {
    expect(SEARCH_SOURCE_REGISTRY.map((entry) => entry.id).sort()).toEqual([...SEARCH_SOURCES].sort());
    expect(new Set(SEARCH_SOURCE_REGISTRY.map((entry) => entry.id)).size).toBe(SEARCH_SOURCES.length);
    for (const entry of SEARCH_SOURCE_REGISTRY) {
      expect(entry.table, entry.id).toMatch(/^(hq|op)_[a-z_]+$/);
      expect(entry.statement.length, entry.id).toBeGreaterThan(20);
    }
  });

  it('names exactly three classified sources — the three canonical rows that carry a privacy column', () => {
    // If a fourth source ever gains a privacy column, this fails until the
    // registry and the corpus builder are both taught about it. That is the
    // point: a classified row projected as `internal` by default would be a
    // silent leak.
    expect(SEARCH_SOURCE_REGISTRY.filter((entry) => entry.classified).map((entry) => entry.id).sort()).toEqual([
      'collaboration',
      'memory',
      'truth',
    ]);
  });

  it('resolves a descriptor for every declared source', () => {
    for (const id of SEARCH_SOURCES) expect(searchSourceDescriptor(id).id).toBe(id);
  });

  it('states the categorical vocabularies and nothing numeric', () => {
    expect([...ANSWER_STATES]).toEqual(['grounded', 'insufficient_evidence', 'unknown']);
    expect([...RETRIEVAL_MODES]).toEqual(['deterministic_lexical', 'semantic_embedding']);
    expect([...TERM_MATCHES]).toEqual(['all_terms', 'any_term']);
    expect([...ANSWER_UNKNOWN_REASONS]).toEqual([
      'no_searchable_terms',
      'no_matching_canonical_record',
      'no_source_store_present',
    ]);
    expect([...RETRIEVAL_UNAVAILABLE_REASONS]).toEqual([
      'no_adapter_installed',
      'requires_external_service',
      'not_activated',
    ]);
  });
});

describe('a query with no criterion is refused, not answered', () => {
  it('refuses an empty query outright', () => {
    const refused = normalizeSearchQuery({});
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('at least one search criterion');
  });

  it('refuses a query whose every word is a stopword', () => {
    const refused = normalizeSearchQuery({ text: 'what is the of and' });
    expect(refused.ok).toBe(false);
  });

  it('accepts a query with only a structured filter and no text', () => {
    const accepted = normalizeSearchQuery({ sources: ['memory'] });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.criteria).toEqual(['sources: memory']);
  });

  it('refuses an unknown source and a malformed year rather than ignoring them', () => {
    expect(normalizeSearchQuery({ sources: ['products' as SearchSourceId] }).ok).toBe(false);
    expect(normalizeSearchQuery({ text: 'x', year: '26' }).ok).toBe(false);
  });

  it('reports every word it did not apply — stopwords and anything over the cap', () => {
    const many = Array.from({ length: MAX_QUERY_TERMS + 3 }, (_, i) => `word${i}`).join(' ');
    const normalized = normalizeSearchQuery({ text: `what is the ${many}` });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.terms).toHaveLength(MAX_QUERY_TERMS);
    // The three stopwords plus the three words beyond the cap.
    expect(normalized.ignoredTerms).toEqual([
      'what',
      'is',
      'the',
      `word${MAX_QUERY_TERMS}`,
      `word${MAX_QUERY_TERMS + 1}`,
      `word${MAX_QUERY_TERMS + 2}`,
    ]);
  });

  it('carries no domain word in the stopword list', () => {
    // A stopword that named a company concept would silently make canonical
    // rows unreachable. Every entry must be an English function word or a
    // query verb.
    for (const domain of [
      'mission',
      'truth',
      'memory',
      'task',
      'project',
      'worker',
      'evidence',
      'verified',
      'blocked',
      'approval',
      'decision',
    ]) {
      expect(QUERY_STOPWORDS.has(domain), domain).toBe(false);
    }
  });
});

describe('retrieval is deterministic and its order is stated', () => {
  const older = doc({ source: 'memory', entityId: 'a', body: 'alpha beta', at: '2026-01-01T00:00:00.000Z' });
  const newer = doc({ source: 'memory', entityId: 'b', body: 'alpha', at: '2026-05-01T00:00:00.000Z' });
  const sameTimeTask = doc({ source: 'task', entityId: 'c', body: 'alpha', at: '2026-05-01T00:00:00.000Z' });

  it('orders by matched-term count, then newest, then source registry order, then id', () => {
    const ordered = orderDocuments([newer, older, sameTimeTask], ['alpha', 'beta']);
    // `older` matches both terms and wins despite being older; the two
    // one-term matches tie on time and fall to the registry order, where
    // `task` precedes `memory`.
    expect(ordered.map((d) => d.id)).toEqual(['memory:a', 'task:c', 'memory:b']);
    expect(SEARCH_SOURCES.indexOf('task')).toBeLessThan(SEARCH_SOURCES.indexOf('memory'));
  });

  it('gives byte-identical results for the same corpus and query, every call', () => {
    const first = runSearch([older, newer, sameTimeTask], 'alpha');
    const second = runSearch([sameTimeTask, newer, older], 'alpha');
    expect(JSON.stringify(second.hits)).toEqual(JSON.stringify(first.hits));
  });

  it('matches ALL terms for an explicit search, and says so', () => {
    const result = runSearch([older, newer], 'alpha beta');
    expect(result.match).toBe('all_terms');
    expect(result.hits.map((hit) => hit.document.entityId)).toEqual(['a']);
  });

  it('matches ANY term through the adapter when the caller asks for it', () => {
    const any = LEXICAL_RETRIEVAL_ADAPTER.retrieve({
      readable: [older, newer],
      terms: ['beta', 'nothingmatchesthis'],
      match: 'any_term',
    });
    expect(any.map((d) => d.id)).toEqual(['memory:a']);
  });

  it('publishes which terms matched, and never a score', () => {
    const result = runSearch([older], 'alpha beta');
    expect(result.hits[0]!.matchedTerms).toEqual(['alpha', 'beta']);
    const wire = JSON.stringify(result);
    for (const banned of ['"score"', '"relevance"', '"rank"', '"confidence"', '"weight"', '"percent"']) {
      expect(wire, banned).not.toContain(banned);
    }
  });
});

describe('results are bounded, and the bound is stated rather than silent', () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    doc({ source: 'memory', entityId: `m${String(i).padStart(3, '0')}`, body: 'alpha' }),
  );

  it('caps the page at SEARCH_READ_LIMIT however large a limit is asked for', () => {
    const normalized = normalizeSearchQuery({ text: 'alpha' });
    if (!normalized.ok) throw new Error(normalized.message);
    const result = runCompanySearch({
      corpus: corpusOf(many),
      query: { text: 'alpha', limit: 10_000 },
      terms: normalized.terms,
      ignoredTerms: normalized.ignoredTerms,
      criteria: normalized.criteria,
      includeFounderOnly: true,
      now: '2026-09-07T00:00:00.000Z',
    });
    expect(result.limit).toBe(SEARCH_READ_LIMIT);
    expect(result.hits).toHaveLength(SEARCH_READ_LIMIT);
    expect(result.total).toBe(80);
    expect(result.truncated).toBe(true);
  });

  it('states the true readable total beside the bounded page', () => {
    const result = runSearch(many, 'alpha');
    expect(result.hits.length).toBeLessThan(result.total);
    expect(result.total).toBe(80);
  });

  it('bounds a snippet and marks where it was cut', () => {
    const long = doc({ source: 'memory', entityId: 'long', body: `${'x '.repeat(400)}alpha` });
    const snippet = snippetOf(long, ['alpha']);
    expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_LENGTH + 2);
    expect(snippet).toContain('…');
  });
});

describe('privacy is the reader’s, and the withheld count is not a query oracle', () => {
  const openDoc = doc({ source: 'memory', entityId: 'open', body: 'alpha public' });
  const secretA = doc({ source: 'memory', entityId: 's1', body: 'alpha secretone', privacy: 'founder_only' });
  const secretB = doc({ source: 'truth', entityId: 's2', body: 'beta secrettwo', privacy: 'founder_only' });

  it('carries no founder_only document, snippet or term for a reader without the right', () => {
    const result = runSearch([openDoc, secretA, secretB], 'alpha', false);
    expect(result.total).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secretone');
    expect(JSON.stringify(result)).not.toContain('secrettwo');
  });

  it('reports the SAME withheld number for two different queries — a corpus fact, not a probe', () => {
    const all = [openDoc, secretA, secretB];
    const one = runSearch(all, 'alpha', false);
    const two = runSearch(all, 'zzzznothing', false);
    expect(one.withheldFounderOnly).toBe(2);
    expect(two.withheldFounderOnly).toBe(2);
    // The number is a property of the corpus, so a reader learns nothing about
    // WHICH private record matched by varying the query.
    expect(two.withheldFounderOnly).toBe(one.withheldFounderOnly);
  });

  it('counts per-source readable documents over the reader’s set only', () => {
    const statuses = sourceStatuses(corpusOf([openDoc, secretA, secretB]), [openDoc]);
    expect(statuses.find((s) => s.id === 'memory')!.readableDocuments).toBe(1);
    expect(statuses.find((s) => s.id === 'truth')!.readableDocuments).toBe(0);
  });
});

describe('a document projects into the EXISTING archive index, not a second one', () => {
  it('keeps the source as the archive category and the lifecycle as the archive status', () => {
    const stale = doc({ source: 'memory', entityId: 'x', lifecycle: 'superseded' });
    const projected = asArchiveProjection(stale);
    expect(projected.category).toBe('memory');
    expect(projected.status).toBe('SUPERSEDED');
    expect(projected.sourceRef).toBe('hq://memory/x');
  });

  it('never projects the body of a document into a field the view then omits', () => {
    // The browser projection carries no `body`: text reaches a reader only as
    // a bounded snippet beside the row it was quoted from.
    const view = searchDocumentView(doc({ source: 'memory', entityId: 'x', body: 'the whole body' }));
    expect(Object.keys(view)).not.toContain('body');
    expect(JSON.stringify(view)).not.toContain('the whole body');
  });
});

describe('the semantic adapter boundary exists and is deliberately empty', () => {
  it('installs no semantic adapter in this build', () => {
    expect(SEMANTIC_RETRIEVAL_ADAPTERS).toHaveLength(0);
  });

  it('answers a semantic request with the deterministic adapter and states why', () => {
    const resolved = resolveRetrievalAdapter('semantic_embedding');
    expect(resolved.adapter.id).toBe(LEXICAL_RETRIEVAL_ADAPTER.id);
    expect(resolved.statement.mode).toBe('deterministic_lexical');
    expect(resolved.statement.requested).toBe('semantic_embedding');
    expect(resolved.statement.fallbackReason).toBe('no_adapter_installed');
    expect(resolved.statement.note).toContain('nothing was activated');
  });

  it('states no fallback when the deterministic mode was the one asked for', () => {
    const resolved = resolveRetrievalAdapter('deterministic_lexical');
    expect(resolved.statement.fallbackReason).toBeNull();
  });

  it('hands an adapter no handle, identity, capability or privacy decision', () => {
    // Structural: the only inputs are documents the reader may ALREADY see and
    // the tokenized terms. An adapter can narrow or reorder; it cannot widen.
    const input = { readable: [] as SearchDocument[], terms: [] as string[], match: 'all_terms' as const };
    expect(Object.keys(input).sort()).toEqual(['match', 'readable', 'terms']);
    expect(LEXICAL_RETRIEVAL_ADAPTER.retrieve(input)).toEqual([]);
  });
});

describe('an answer is composed from fields, and says so', () => {
  const verified = doc({
    source: 'truth',
    entityId: 't1',
    title: 'The run completed',
    body: 'The alpha run completed',
    status: 'verified',
    truthState: 'verified',
    lifecycle: 'current',
    evidenceRefs: ['ev-1'],
    at: '2026-05-01T00:00:00.000Z',
  });
  const stale = doc({
    source: 'memory',
    entityId: 'm1',
    title: 'Old budget',
    body: 'The alpha budget was four seconds',
    status: 'SUPERSEDED',
    lifecycle: 'superseded',
    at: '2026-01-01T00:00:00.000Z',
  });

  function answer(retrieved: SearchDocument[], over: Partial<Parameters<typeof assembleAnswer>[0]> = {}) {
    return assembleAnswer({
      question: 'what about alpha?',
      askedAt: '2026-09-07T00:00:00.000Z',
      terms: ['alpha'],
      ignoredTerms: ['what', 'about'],
      match: 'any_term',
      retrieved,
      considered: retrieved.length,
      sources: sourceStatuses(corpusOf(retrieved), retrieved),
      withheldFounderOnly: 0,
      retrieval: resolveRetrievalAdapter().statement,
      noStorePresent: false,
      ...over,
    });
  }

  it('grounds an answer in the retrieved rows and cites each by table and id', () => {
    const result = answer([verified]);
    expect(result.state).toBe('grounded');
    expect(result.unknownReason).toBeNull();
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.document.table).toBe('hq_truth_records');
    expect(result.citations[0]!.document.entityId).toBe('t1');
    expect(result.citations[0]!.matchedTerms).toEqual(['alpha']);
    expect(result.truth).toEqual({
      cited: 1,
      byState: { claimed: 0, observed: 0, verified: 1, accepted: 0 },
      strongest: 'verified',
    });
    expect(result.response).toContain('Answered from 1 canonical record (truth 1)');
    expect(result.response).toContain('Cited truth records stand at: verified 1.');
  });

  it('returns insufficient evidence when retrieval matched nothing, and never invents prose', () => {
    const result = answer([]);
    expect(result.state).toBe('insufficient_evidence');
    expect(result.unknownReason).toBe('no_matching_canonical_record');
    expect(result.citations).toEqual([]);
    expect(result.response).toContain('HQ holds no canonical record matching this question');
    expect(result.response).toContain('not a statement that the thing asked about is false');
  });

  it('returns unknown when there was no searchable term at all', () => {
    const result = answer([], { terms: [], considered: 0 });
    expect(result.state).toBe('unknown');
    expect(result.unknownReason).toBe('no_searchable_terms');
  });

  it('returns unknown when no source store exists on the handle', () => {
    const result = answer([], { noStorePresent: true });
    expect(result.state).toBe('unknown');
    expect(result.unknownReason).toBe('no_source_store_present');
  });

  it('labels a superseded citation stale in the record AND in the composed sentence', () => {
    const result = answer([verified, stale]);
    expect(result.citations.find((c) => c.document.entityId === 'm1')!.stale).toBe(true);
    expect(result.response).toContain('1 cited record has been superseded and is labelled stale.');
    expect(result.limitations.map((l) => l.code)).toContain('superseded_records_cited');
  });

  it('states every limitation it is under, from the closed vocabulary', () => {
    const result = answer([stale], { considered: 5, withheldFounderOnly: 2 });
    const codes = result.limitations.map((l) => l.code);
    expect(codes).toContain('composed_from_fields_only');
    expect(codes).toContain('lexical_retrieval_only');
    expect(codes).toContain('terms_ignored');
    expect(codes).toContain('bounded_retrieval');
    expect(codes).toContain('no_truth_record_cited');
    expect(codes).toContain('no_evidence_cited');
    expect(codes).toContain('founder_only_not_searched');
    for (const code of codes) expect(ANSWER_LIMITATIONS).toContain(code);
    for (const entry of result.limitations) expect(entry.statement.length).toBeGreaterThan(20);
  });

  it('flags an unverified truth citation as an assertion, not a fact', () => {
    const claimed = doc({
      source: 'truth',
      entityId: 't2',
      body: 'alpha',
      status: 'claimed',
      truthState: 'claimed',
      lifecycle: 'current',
    });
    const result = answer([claimed]);
    expect(result.limitations.map((l) => l.code)).toContain('unverified_truth_cited');
    expect(result.truth.strongest).toBe('claimed');
  });

  it('composes only counts and categorical states — never a row’s free text', () => {
    // The body appears in the SNIPPET, beside the table and id it was quoted
    // from, and never inside the composed sentence.
    const text = composeAnswerText({
      citations: [
        {
          document: searchDocumentView(stale),
          matchedTerms: ['alpha'],
          snippet: stale.body,
          stale: true,
        },
      ],
      considered: 1,
      truthByState: Object.fromEntries(TRUTH_STATES.map((s) => [s, 0])) as Record<
        (typeof TRUTH_STATES)[number],
        number
      >,
    });
    expect(text).not.toContain('four seconds');
    expect(text).not.toContain('Old budget');
  });

  it('never cites more than ASK_CITATION_LIMIT allows the facade to hand it', () => {
    expect(ASK_CITATION_LIMIT).toBeLessThanOrEqual(SEARCH_READ_LIMIT);
  });
});

describe('matched terms are a fact about the document, not about the query', () => {
  it('reports only the terms that genuinely occur in the indexed text', () => {
    const document = doc({ source: 'memory', entityId: 'x', title: 'Alpha plan', body: 'gamma' });
    expect(matchedTermsOf(document, ['alpha', 'beta', 'gamma'])).toEqual(['alpha', 'gamma']);
  });

  it('does not treat a source id or an entity id as free text a caller can forge', () => {
    const document = doc({ source: 'memory', entityId: 'abc123', body: 'plain' });
    // The id IS indexed, deliberately (looking a record up by id is a search).
    expect(matchedTermsOf(document, ['abc123'])).toEqual(['abc123']);
    // But nothing about a term changes the document's own fields.
    expect(document.privacy).toBe('internal');
  });
});
