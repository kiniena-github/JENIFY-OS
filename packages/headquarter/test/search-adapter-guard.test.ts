/**
 * The pre-real-adapter `assertBrowserSafe` Low, resolved and pinned.
 *
 * ## The recorded defect
 *
 * On the Phase 11 search / Ask Jenify path, `assertBrowserSafe` scanning of the
 * free text (`text`, `project`, `tag`, `question`) was enforced **at the
 * browser route only**, and the `RetrievalAdapter` seam
 * (`SEMANTIC_RETRIEVAL_ADAPTERS`, empty, `fallbackReason:
 * 'no_adapter_installed'`) is what a real semantic retriever plugs into.
 *
 * That was safe exactly while the adapter set was empty: the one installed
 * adapter is a local inverted index that transmits nothing. It stops being
 * safe the day a real adapter exists, because a semantic retriever is a thing
 * that SENDS the query somewhere, and an in-process caller of the facade
 * bypasses the route entirely. Phase 14 is the layer that would introduce such
 * an adapter, so it is the phase that closes it.
 *
 * ## The fix, and why it is structural
 *
 * `resolveRetrievalAdapter` is the only way to obtain an adapter, and it now
 * returns a GUARDED wrapper in every branch — the lexical one, an installed
 * semantic one, and the fallback. The wrapper scans the free text before it
 * delegates, so no adapter present or future can be handed text HQ has not
 * scanned, and an adapter added to `SEMANTIC_RETRIEVAL_ADAPTERS` cannot opt
 * out. The facade scans the same fields on the way IN as well, so an
 * in-process caller gets a stated refusal instead of an exception from deep
 * inside a retrieval.
 *
 * The route's own scan is unchanged: it has a better refusal to give
 * (`400 unsafe_query`), and it is kept as the outer layer.
 */

import { describe, expect, it } from 'vitest';
import {
  LEXICAL_RETRIEVAL_ADAPTER,
  RETRIEVAL_GUARD_STATEMENT,
  RetrievalSafetyError,
  SEMANTIC_RETRIEVAL_ADAPTERS,
  assertRetrievalTextSafe,
  guardRetrievalAdapter,
  resolveRetrievalAdapter,
  type RetrievalAdapter,
  type SearchDocument,
} from '../src/application/search-command.js';
import { setupFixture } from './application.fixture.js';

/** A credential-shaped string the browser guard recognises by SHAPE. */
const SECRET = 'sk-abcdefghijklmnop12345678';

/**
 * A stand-in for the thing the seam exists for: an adapter that RECORDS
 * everything it is handed. A real one would transmit it.
 */
function recordingAdapter(): RetrievalAdapter & { seen: string[][] } {
  const seen: string[][] = [];
  return {
    id: 'test.recording',
    mode: 'semantic_embedding',
    available: true,
    unavailableReason: null,
    seen,
    retrieve({ readable, terms }) {
      seen.push([...terms]);
      return [...readable] as SearchDocument[];
    },
  };
}

describe('no adapter, present or future, can be handed unscanned free text', () => {
  it('refuses credential-shaped terms at the seam before the adapter sees them', () => {
    const adapter = recordingAdapter();
    const guarded = guardRetrievalAdapter(adapter);
    expect(() => guarded.retrieve({ readable: [], terms: [SECRET], match: 'any_term' })).toThrow(
      RetrievalSafetyError,
    );
    // The load-bearing assertion: the adapter was never called at all.
    expect(adapter.seen).toEqual([]);
  });

  it('passes ordinary terms straight through, unchanged', () => {
    const adapter = recordingAdapter();
    const guarded = guardRetrievalAdapter(adapter);
    guarded.retrieve({ readable: [], terms: ['salt', 'yield'], match: 'all_terms' });
    expect(adapter.seen).toEqual([['salt', 'yield']]);
  });

  it('is transparent in every other respect, so nothing downstream reaches past it', () => {
    const adapter = recordingAdapter();
    const guarded = guardRetrievalAdapter(adapter);
    expect(guarded.id).toBe(adapter.id);
    expect(guarded.mode).toBe(adapter.mode);
    expect(guarded.available).toBe(adapter.available);
    expect(guarded.unavailableReason).toBe(adapter.unavailableReason);
  });

  it('guards EVERY branch of the resolver, including the fallback', () => {
    // A guarded adapter is a different object from the raw one, and each
    // branch of the resolver hands one out.
    const lexical = resolveRetrievalAdapter('deterministic_lexical').adapter;
    const fallback = resolveRetrievalAdapter('semantic_embedding').adapter;
    expect(lexical).not.toBe(LEXICAL_RETRIEVAL_ADAPTER);
    expect(fallback).not.toBe(LEXICAL_RETRIEVAL_ADAPTER);
    for (const adapter of [lexical, fallback]) {
      expect(() => adapter.retrieve({ readable: [], terms: [SECRET], match: 'any_term' })).toThrow(
        RetrievalSafetyError,
      );
    }
    // The installed set is still empty, and the fallback still says so.
    expect(SEMANTIC_RETRIEVAL_ADAPTERS).toHaveLength(0);
    expect(resolveRetrievalAdapter('semantic_embedding').statement.fallbackReason).toBe(
      'no_adapter_installed',
    );
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('applied by the resolver');
  });

  it('scans a field set and ignores blanks, so an absent criterion is not an error', () => {
    expect(() => assertRetrievalTextSafe({ text: 'salt', project: '', tag: undefined }, 'search')).not.toThrow();
    expect(() => assertRetrievalTextSafe({}, 'search')).not.toThrow();
    expect(() => assertRetrievalTextSafe({ project: SECRET }, 'search')).toThrow(RetrievalSafetyError);
  });
});

describe('the IN-PROCESS facade caller is covered, not only the browser route', () => {
  it('refuses a credential-shaped search text, project and tag with a stated reason', () => {
    const fx = setupFixture();
    for (const query of [{ text: SECRET }, { project: SECRET }, { tag: SECRET }]) {
      const result = fx.ops.searchCompany(query);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message).toContain('before any retrieval adapter can see it');
      // The refusal does not echo the material back.
      expect(JSON.stringify(result.error)).not.toContain(SECRET);
    }
  });

  it('refuses a credential-shaped question with a stated reason', () => {
    const fx = setupFixture();
    const result = fx.ops.askJenify({ question: `what is ${SECRET}` });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(JSON.stringify(result.error)).not.toContain(SECRET);
  });

  it('still answers an ordinary search and an ordinary question', () => {
    // The guard must not have narrowed the surface it protects.
    const fx = setupFixture();
    const search = fx.ops.searchCompany({ text: 'salt' });
    expect(search.ok).toBe(true);
    const ask = fx.ops.askJenify({ question: 'what is the salt yield?' });
    expect(ask.ok).toBe(true);
  });

  it('refuses BEFORE normalization, so the material never reaches the criteria echo', () => {
    // `normalizeSearchQuery` echoes `project` and `tag` verbatim into
    // `criteria`; the scan therefore has to run first, or a refusal further
    // down would already have copied the text into a structure.
    const fx = setupFixture();
    const result = fx.ops.searchCompany({ project: SECRET });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details).toBeUndefined();
  });
});
