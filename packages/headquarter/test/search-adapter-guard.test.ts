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
 * semantic one, and the fallback. There is therefore no code path through the
 * resolver that yields an UNWRAPPED adapter, and an adapter added to
 * `SEMANTIC_RETRIEVAL_ADAPTERS` cannot opt out. The facade scans the four raw
 * fields on the way IN, which is where a credential is actually met.
 *
 * The route's own scan is unchanged: it has a better refusal to give
 * (`400 unsafe_query`), and it is kept as the outer layer.
 *
 * ## Which layer is the guarantee, stated exactly
 *
 * The Wave 5 review (LOW finding 3) established that the seam guard's scan is
 * INERT on the terms the real pipeline produces: terms are always `tokenize()`
 * output, which lowercases and splits on `[^a-z0-9]+`, stripping every
 * separator the eleven `SECRET_VALUE_PATTERNS` require. The structural claims
 * all held — every resolver branch returns a wrapper, and a recording stand-in
 * is never called with credential-shaped terms — but "the inner one is the
 * guarantee" was the wrong way round.
 *
 * So this file now says which is which, in the test names as well as here:
 *
 *  - the FACADE scan (and the route's, outside it) is the GUARANTEE for the
 *    pipeline: it sees the raw field, before normalization and before
 *    tokenization;
 *  - the SEAM guard is DEFENCE IN DEPTH against a non-tokenized caller — one
 *    that resolves an adapter itself and supplies terms it built. That caller
 *    is real and reachable, since `resolveRetrievalAdapter` is exported.
 *
 * A test below pins the tokenization fact itself, so the claim cannot quietly
 * become wrong again in either direction.
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
import { tokenize } from '../src/archive/search.js';
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

describe('the seam guard: defence in depth against a caller that supplies its own terms', () => {
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

  /**
   * The fact the layer claims now rest on (Wave 5 review, LOW finding 3).
   *
   * `tokenize` lowercases and splits on `[^a-z0-9]+`, so a credential arriving
   * as free text is in pieces by the time the seam sees it — every hyphen,
   * underscore, dot, colon and space the shape patterns need is gone. This is
   * asserted rather than assumed, so nobody has to take the comment's word for
   * why the FACADE scan is the layer that matters.
   */
  it('is INERT on tokenized terms, which is why the facade scan is the guarantee', () => {
    for (const credential of [
      SECRET,
      'ghp_ABCDEFGHIJKLMNOPQRST1234',
      'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM',
      'Bearer abcdefghijklmnop1234',
      'api_key: abcd1234efgh5678',
      // The seventh shape, added by correction cycle 2 of the Wave 5 review.
      // This exact string was ALLOWED by the facade before the pattern
      // existed, while the phase document claimed the layer was pinned against
      // "six real credential shapes" — the count was true and the implication
      // was not.
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      // The facade scan sees this and refuses it.
      expect(() => assertRetrievalTextSafe({ text: credential }, 'search')).toThrow(
        RetrievalSafetyError,
      );
      // After tokenization the same material no longer matches any shape, so
      // the seam scan lets it through. That is not a hole — the facade already
      // refused it — but it IS the reason the seam is defence in depth rather
      // than the guarantee.
      const terms = tokenize(credential);
      expect(terms.length).toBeGreaterThan(0);
      const adapter = recordingAdapter();
      const guarded = guardRetrievalAdapter(adapter);
      guarded.retrieve({ readable: [], terms, match: 'any_term' });
      expect(adapter.seen).toEqual([terms]);
    }
  });

  it('does not overstate itself: the statement names the facade as the guarantee', () => {
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('at the FACADE');
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('defence in depth');
    // The old wording claimed the seam scan covered every adapter's free text.
    expect(RETRIEVAL_GUARD_STATEMENT).not.toContain('can be handed text HQ has not scanned');
  });

  it('names the shapes it covers and the ones it does not (Wave 5 correction cycle 2, LOW 3)', () => {
    // "credential shapes" unqualified reads as "credentials". The statement
    // now enumerates both directions, so a reader can tell what this layer is
    // and is not without opening the regex array.
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('a NAMED list of shapes, not credentials in general');
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('AWS long-term access key ids');
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('does NOT recognise an AWS secret access key');
  });
});

describe('the FACADE scan is the guarantee for the pipeline, not only the browser route', () => {
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
