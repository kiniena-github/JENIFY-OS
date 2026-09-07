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

  it('exports only GUARDED adapters, so there is no unwrapped binding to obtain', () => {
    // This used to assert `expect(lexical).not.toBe(LEXICAL_RETRIEVAL_ADAPTER)`
    // — that the resolver wraps a raw exported constant. That was true and it
    // was the weaker half of the claim being made: the RAW adapters were
    // exported, `application/index.ts` re-exported them, and
    // `search-core.test.ts` already called `LEXICAL_RETRIEVAL_ADAPTER.retrieve`
    // unwrapped, so "an in-process caller cannot obtain an unwrapped adapter"
    // was false of the module (Wave 5 review, Medium finding C-2).
    //
    // The raw adapters are module-private now and the exported bindings are
    // the wrappers, so the assertion inverts: the resolver hands back the SAME
    // object, because there is no unguarded one left to hand back.
    const lexical = resolveRetrievalAdapter('deterministic_lexical').adapter;
    const fallback = resolveRetrievalAdapter('semantic_embedding').adapter;
    expect(lexical).toBe(LEXICAL_RETRIEVAL_ADAPTER);
    expect(fallback).toBe(LEXICAL_RETRIEVAL_ADAPTER);
    // And every one of them refuses credential-shaped terms — including the
    // EXPORTED constant reached directly, which is the path that was open.
    for (const adapter of [lexical, fallback, LEXICAL_RETRIEVAL_ADAPTER]) {
      expect(() => adapter.retrieve({ readable: [], terms: [SECRET], match: 'any_term' })).toThrow(
        RetrievalSafetyError,
      );
    }
    // The installed set is still empty, and the fallback still says so. Every
    // member of it is guarded at DECLARATION, so an adapter added later cannot
    // be reached unwrapped either.
    expect(SEMANTIC_RETRIEVAL_ADAPTERS).toHaveLength(0);
    expect(Object.isFrozen(SEMANTIC_RETRIEVAL_ADAPTERS)).toBe(true);
    expect(resolveRetrievalAdapter('semantic_embedding').statement.fallbackReason).toBe(
      'no_adapter_installed',
    );
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('applied AT DECLARATION');
    expect(RETRIEVAL_GUARD_STATEMENT).not.toContain('applied by the resolver');
    // Carried from the other correction lane, which fixed the same finding in
    // PROSE. Its `toContain('the resolver hands out')` and its two
    // facade-is-the-guarantee assertions hold against the surviving wording and
    // are kept. The one assertion NOT carried is
    // `toContain('exported for testing and are not wrapped')`: that sentence
    // was a disclosure that the raw adapters were reachable, and it is false of
    // this implementation — so the assertion is INVERTED rather than dropped,
    // because a statement that still said it would now be a lie in the safe
    // direction's favour.
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('the resolver hands out');
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('FACADE scan');
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('defence in depth');
    expect(RETRIEVAL_GUARD_STATEMENT).not.toContain('exported for testing');
    expect(RETRIEVAL_GUARD_STATEMENT).not.toContain('cannot obtain an unguarded adapter');
  });

  /**
   * Wave 5 Medium 9, the substantive half, from the prose lane. The inner
   * wrapper is defence in depth precisely because `normalizeSearchQuery` has
   * already TOKENIZED the terms by the time an adapter sees them, and a
   * tokenized term cannot carry the `key: value` punctuation these credential
   * patterns need. Pinned so the doc's claim about which layer is load-bearing
   * stays true.
   */
  it('shows why the inner wrapper is defence in depth: tokenized terms cannot match', () => {
    const raw = resolveRetrievalAdapter('deterministic_lexical').adapter;
    // The unsplit credential string DOES trip the wrapper...
    expect(() => raw.retrieve({ readable: [], terms: [SECRET], match: 'any_term' })).toThrow(
      RetrievalSafetyError,
    );
    // ...but the tokens the facade actually passes do not, which is why the
    // facade's own scan on the way in is the effective layer.
    const tokens = tokenize(SECRET);
    expect(tokens.length).toBeGreaterThan(0);
    expect(() => raw.retrieve({ readable: [], terms: tokens, match: 'any_term' })).not.toThrow();
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
  it('is INERT on tokenized SEPARATOR-BEARING shapes, which is why the facade scan is the guarantee', () => {
    for (const credential of [
      SECRET,
      'ghp_ABCDEFGHIJKLMNOPQRST1234',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM',
      'Bearer abcdefghijklmnop1234',
      'api_key: abcd1234efgh5678',
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

  /**
   * The half of the same fact that changed with the Wave 5 correction of LOW
   * finding C-2 — and it changed in the safe direction, so it is pinned rather
   * than left to be discovered.
   *
   * A Google API key carries NO separator at all. Tokenization therefore leaves
   * it intact apart from case, and once `SECRET_VALUE_PATTERNS` became
   * case-insensitive the seam guard does catch it. So "the seam is inert on
   * anything the pipeline can produce" — the wording the previous correction
   * used — is no longer exactly true, and the doc and comments say the
   * narrower, true thing instead: it is inert on the shapes whose match
   * DEPENDS on a separator, which is most of them.
   */
  it('is NOT inert on a separator-free shape, now that the patterns are case-insensitive', () => {
    const googleKey = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    expect(() => assertRetrievalTextSafe({ text: googleKey }, 'search')).toThrow(RetrievalSafetyError);
    const terms = tokenize(googleKey);
    expect(terms).toEqual([googleKey.toLowerCase()]);
    const adapter = recordingAdapter();
    const guarded = guardRetrievalAdapter(adapter);
    expect(() => guarded.retrieve({ readable: [], terms, match: 'any_term' })).toThrow(
      RetrievalSafetyError,
    );
    // Refused BEFORE the adapter saw anything.
    expect(adapter.seen).toEqual([]);
    // And the case-only variant the guard used to let through is refused too,
    // which is the whole point of the change.
    expect(() => assertRetrievalTextSafe({ text: googleKey.toUpperCase() }, 'search')).toThrow(
      RetrievalSafetyError,
    );
  });

  it('does not overstate itself: the statement names the facade as the guarantee', () => {
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('at the FACADE');
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('defence in depth');
    // The old wording claimed the seam scan covered every adapter's free text.
    expect(RETRIEVAL_GUARD_STATEMENT).not.toContain('can be handed text HQ has not scanned');
    // And it still says WHO applies the wrapper. Two correction lanes asserted
    // this differently — `toContain('applied by the resolver')` and
    // `toContain('done by the resolver rather than by the caller')` — and both
    // pin the same claim: the caller does not choose to be guarded. The claim
    // is what is carried across to the surviving wording, which is STRONGER
    // than either (the wrapping happens at declaration, so it holds even for a
    // caller that never reaches the resolver), so the assertion is on the half
    // both lanes shared rather than on either lane's spelling of the mechanism.
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('rather than by the caller');
    expect(RETRIEVAL_GUARD_STATEMENT).toContain('cannot opt out');
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
