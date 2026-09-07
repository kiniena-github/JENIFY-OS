/**
 * Phase 11 — Unified Search, Company Memory retrieval and Ask Jenify.
 *
 * The Founder asks HQ a question in words and gets an answer GROUNDED in the
 * canonical company record. Four laws, stated here because they are the phase
 * boundary and every function below is written to keep them:
 *
 * 1. **Reader, never authority.** Nothing in this module or in the facade
 *    methods that use it writes a row, appends an event, appends evidence,
 *    registers a capability, resolves an identity or grants anything. Search
 *    and Ask Jenify are PROJECTIONS over stores other phases own. There is no
 *    Phase 11 table, no Phase 11 capability and no Phase 11 write — a search
 *    surface that stored its own index would be a second answer to "what does
 *    the company hold", which is exactly the second authority the repository
 *    rules forbid.
 * 2. **Retrieve first, then compose.** `askJenify` runs retrieval over the
 *    canonical corpus and composes its response ONLY from fields of the rows
 *    that came back. No sentence in an answer states a fact that is not a
 *    field of a cited document. When retrieval returns nothing, the answer is
 *    `insufficient_evidence` or `unknown` — never a guess, never prose that
 *    sounds like knowledge. This is a deterministic composer over rows; it is
 *    NOT a language model and it calls nothing.
 * 3. **Deterministic and bounded.** The index is the existing dependency-free
 *    inverted index in `archive/search.ts` (`tokenize` / `buildIndex` /
 *    `search`) — this module implements no second index and no scorer. There
 *    is no relevance number anywhere: the only match fact published is WHICH
 *    query terms matched, which is checkable. Every result set is bounded with
 *    its true total stated beside it, and a query with no criterion at all is
 *    refused rather than answered with a dump of the company record.
 * 4. **Privacy is decided by the reader, and never by the query.** A
 *    `founder_only` document is filtered out for a reader who may not see it,
 *    BEFORE bounding and before composition, so no count, snippet, citation,
 *    term or total spans it. The number of classified documents this reader
 *    cannot search is stated once as a corpus-wide, QUERY-INDEPENDENT fact —
 *    deliberately not a per-query count, because a per-query withheld count is
 *    an oracle a reader could binary-search the private record with.
 *
 * ## The semantic adapter boundary
 *
 * Semantic/embedding retrieval is defined here as an ADAPTER interface with a
 * deterministic local implementation and NO installed alternative. Resolving a
 * semantic request returns the deterministic adapter and states why, rather
 * than throwing or pretending. Nothing in this file opens a socket, reads an
 * environment variable, or names a service — activating one would be a paid
 * external service, which is a Founder-gated decision this phase does not make.
 */

import {
  buildIndex,
  search as searchArchiveIndex,
  tokenize,
  type SearchIndex as ArchiveSearchIndex,
} from '../archive/search.js';
import type { ArchiveRecord, ArchiveStatus } from '../archive/schema.js';
import type { MemoryPrivacy } from '../memory/schema.js';
import { TRUTH_STATES, type TruthState } from './truth-command.js';

/* ------------------------------------------------------------------ */
/* Vocabulary (categorical only)                                       */
/* ------------------------------------------------------------------ */

/**
 * The canonical stores search reads, in the order results are grouped when
 * two documents share a timestamp.
 *
 * This list IS the source registry: adding a source is adding an entry here
 * plus a projection in the facade's corpus builder. Phase 12's product and
 * artifact registers joined by doing exactly that — one entry each here, one
 * projection each in `#searchCorpus`, and nothing else: no ranking change, no
 * index change, no new store for search itself. Nothing is listed
 * speculatively: a source appears here only when a canonical store genuinely
 * backs it today.
 */
export const SEARCH_SOURCES = [
  'mission',
  'project',
  'task',
  'product',
  'artifact',
  'memory',
  'truth',
  'collaboration',
  'external_action',
  'orchestration_run',
  'worker',
] as const;

export type SearchSourceId = (typeof SEARCH_SOURCES)[number];

export function isSearchSource(value: unknown): value is SearchSourceId {
  return typeof value === 'string' && (SEARCH_SOURCES as readonly string[]).includes(value);
}

/**
 * Whether the canonical row a document projects is the CURRENT one.
 *
 * `not_applicable` is honest rather than convenient: most canonical rows have
 * no supersession model at all, and calling them `current` would imply HQ had
 * checked something it never checked.
 */
export type SearchLifecycle = 'current' | 'superseded' | 'not_applicable';

/** What one source is, and what a reader may conclude from a hit in it. */
export interface SearchSourceDescriptor {
  id: SearchSourceId;
  /** The canonical table the documents of this source are projected from. */
  table: string;
  /** What a document of this source IS — used verbatim in provenance. */
  statement: string;
  /**
   * Whether rows of this source carry their own `internal | founder_only`
   * classification. `false` means every document is `internal` because the
   * canonical row has no privacy column — stated, never assumed either way.
   */
  classified: boolean;
  /** Whether the source's rows can be superseded (so `lifecycle` is meaningful). */
  supersedable: boolean;
}

export const SEARCH_SOURCE_REGISTRY: readonly SearchSourceDescriptor[] = [
  {
    id: 'mission',
    table: 'hq_missions',
    statement: 'A commanded mission: its title, objective, scope and any block reason.',
    classified: false,
    supersedable: false,
  },
  {
    id: 'project',
    table: 'hq_projects',
    statement: 'A project on the canonical register: its name, stream and summary.',
    classified: false,
    supersedable: false,
  },
  {
    id: 'task',
    table: 'op_tasks',
    statement:
      'A canonical task: its recorded title, capability and block reason. The task PAYLOAD and RESULT ' +
      'are never indexed and never quoted — the snapshot’s no-task-payload rule applies to search too.',
    classified: false,
    supersedable: false,
  },
  {
    id: 'product',
    table: 'hq_products',
    statement:
      'A product on the Phase 12 register: its name, type, the problem it solves, who it is for, and its ' +
      'DERIVED lifecycle state. The lifecycle is a statement about the product and is never task or ' +
      'worker state.',
    classified: false,
    supersedable: false,
  },
  {
    id: 'artifact',
    table: 'hq_product_artifacts',
    statement:
      'One immutable artifact VERSION: its kind, name, version number, locator and recorded digests. A ' +
      'later version is a different document, so an artifact document is never superseded — the version ' +
      'number is the history, and every version stays searchable.',
    classified: false,
    supersedable: false,
  },
  {
    id: 'memory',
    table: 'hq_memory',
    statement: 'A company memory record: decision, rationale, state, blocker, note or derived summary.',
    classified: true,
    supersedable: true,
  },
  {
    id: 'truth',
    table: 'hq_truth_records',
    statement:
      'A truth record about a canonical entity, carrying its DERIVED Phase 7 state ' +
      '(claimed | observed | verified | accepted) and the op_evidence ids it cites.',
    classified: true,
    supersedable: true,
  },
  {
    id: 'collaboration',
    table: 'hq_collab_sessions',
    statement: 'A Mission Room collaboration session: its title and stated purpose.',
    classified: true,
    supersedable: false,
  },
  {
    id: 'external_action',
    table: 'hq_action_intents',
    statement:
      'An external action intent through the Phase 8 gateway: its type, adapter and target. The action ' +
      'PAYLOAD is never indexed and never quoted.',
    classified: false,
    supersedable: false,
  },
  {
    id: 'orchestration_run',
    table: 'hq_orchestration_runs',
    statement: 'One orchestration cycle: the summary of what it observed and did.',
    classified: false,
    supersedable: false,
  },
  {
    id: 'worker',
    table: 'hq_specialists',
    statement: 'A registered worker in the specialist directory: display name, vendor and role.',
    classified: false,
    supersedable: false,
  },
];

export function searchSourceDescriptor(id: SearchSourceId): SearchSourceDescriptor {
  const found = SEARCH_SOURCE_REGISTRY.find((entry) => entry.id === id);
  // Total by construction: SEARCH_SOURCES and the registry are pinned equal.
  if (!found) throw new Error(`No search source descriptor for ${id}`);
  return found;
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

/** Hard ceiling on hits returned by one search, whatever the caller asks. */
export const SEARCH_READ_LIMIT = 50;
/** Default when the caller states no limit. */
export const SEARCH_DEFAULT_LIMIT = 20;
/** Documents Ask Jenify may cite in one answer. Retrieval stops here. */
export const ASK_CITATION_LIMIT = 8;
/** Longest question this surface will consider. */
export const MAX_QUESTION_LENGTH = 500;
/** Longest free-text query this surface will consider. */
export const MAX_QUERY_TEXT_LENGTH = 200;
/** Query terms honoured, in order; the rest are stated as dropped. */
export const MAX_QUERY_TERMS = 12;
/** Longest body a corpus document carries (the facade truncates when building). */
export const MAX_DOCUMENT_BODY_LENGTH = 2000;
/** Longest snippet quoted back from a document body. */
export const MAX_SNIPPET_LENGTH = 240;
/** Sources carried in the unauthenticated snapshot section. */
export const SEARCH_SNAPSHOT_LIMIT = SEARCH_SOURCES.length;

/* ------------------------------------------------------------------ */
/* The corpus                                                          */
/* ------------------------------------------------------------------ */

/** A canonical entity a document is about — a reference, never a copy. */
export interface SearchEntityRef {
  kind: SearchSourceId | 'evidence' | 'capability';
  id: string;
}

/**
 * One canonical row, projected for retrieval.
 *
 * A document is DERIVED at read time and stored nowhere. `privacy` is copied
 * from the canonical row (or `internal` when the source has no privacy column,
 * per its descriptor), and it is the only thing that decides disclosure.
 */
export interface SearchDocument {
  /** `<source>:<entityId>` — unique across the corpus. */
  id: string;
  source: SearchSourceId;
  entityId: string;
  /** The canonical table this document was projected from. */
  table: string;
  title: string;
  /** The indexed and quotable text. Bounded by the corpus builder. */
  body: string;
  /** The canonical row's own categorical status, in its own vocabulary. */
  status: string;
  lifecycle: SearchLifecycle;
  /** The Phase 7 derived state — truth documents only; null everywhere else. */
  truthState: TruthState | null;
  privacy: MemoryPrivacy;
  /** The canonical timestamp this document is ordered by. */
  at: string;
  /** Free-text project LABEL where the row carries one; '' where it does not. */
  project: string;
  tags: string[];
  /** `op_evidence` ids the row cites — references, never copies. */
  evidenceRefs: string[];
  /** Other canonical entities this row names. */
  refs: SearchEntityRef[];
}

/** Whether a source's store exists on this handle — observed, never migrated. */
export interface SearchSourceStatus {
  id: SearchSourceId;
  table: string;
  /** False when this database carries no such store; the count is then 0 by absence. */
  storePresent: boolean;
  /** Documents of this source the READER may search. Never spans withheld rows. */
  readableDocuments: number;
}

/** Everything retrieval is allowed to see, gathered once by the facade. */
export interface SearchCorpus {
  documents: readonly SearchDocument[];
  sources: readonly { id: SearchSourceId; storePresent: boolean }[];
  builtAt: string;
}

/* ------------------------------------------------------------------ */
/* The retrieval adapter boundary                                      */
/* ------------------------------------------------------------------ */

/**
 * How a set of query terms is matched against a document.
 *
 * `all_terms` is the archive engine's own AND semantics and is what an
 * EXPLICIT search means: the Founder typed those words on purpose. `any_term`
 * is what a QUESTION means — a natural-language sentence carries words no
 * canonical row will ever contain, and requiring all of them would answer
 * every question with "no record", which is a lie of omission rather than an
 * honest unknown. Both are stated on every response, so a reader always knows
 * which rule produced the set in front of them.
 */
export const TERM_MATCHES = ['all_terms', 'any_term'] as const;
export type TermMatch = (typeof TERM_MATCHES)[number];

/**
 * Words removed from a query before matching — a CLOSED, stated list of
 * English function words and query verbs.
 *
 * It exists because `any_term` matching without it would retrieve every
 * document containing "the". It is deliberately small and contains no domain
 * word: nothing here is a fact about the company, so removing one cannot
 * change which canonical rows are reachable, only which noise is not. Every
 * removed word is reported back on the response as an ignored term, so the
 * reader can see exactly what HQ did to their question.
 */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'about', 'all', 'an', 'and', 'any', 'anything', 'are', 'as', 'at', 'be', 'because', 'been', 'being',
  'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'find', 'for', 'from', 'get',
  'give', 'had', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'know', 'list',
  'me', 'my', 'no', 'not', 'now', 'of', 'on', 'or', 'our', 'out', 'over', 'please', 'search', 'show',
  'so', 'some', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'to', 'us', 'was', 'we', 'were', 'what', 'whats', 'when', 'where', 'which', 'who',
  'whom', 'why', 'will', 'with', 'would', 'you', 'your',
]);

export const RETRIEVAL_MODES = ['deterministic_lexical', 'semantic_embedding'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/**
 * Why a requested retrieval mode did not answer. Categorical, so a fallback
 * is always explained by a stated reason rather than by silence.
 */
export const RETRIEVAL_UNAVAILABLE_REASONS = [
  /** No adapter of that mode is installed in this build. */
  'no_adapter_installed',
  /** An adapter exists but would require a paid or hosted service. */
  'requires_external_service',
  /** An adapter is installed and deliberately not activated. */
  'not_activated',
] as const;
export type RetrievalUnavailableReason = (typeof RETRIEVAL_UNAVAILABLE_REASONS)[number];

/**
 * The seam a future semantic retriever would fit into.
 *
 * It takes the already-built corpus and the already-tokenized terms and
 * returns documents in ITS order. It is handed no database handle, no
 * identity, no capability and no privacy decision: privacy filtering happens
 * before an adapter is consulted, so an adapter can only ever narrow or
 * reorder what the reader was already allowed to see. That is the whole point
 * of the boundary — a retrieval strategy must never be able to widen
 * disclosure.
 */
export interface RetrievalAdapter {
  readonly id: string;
  readonly mode: RetrievalMode;
  /** True only when this adapter can genuinely answer here and now. */
  readonly available: boolean;
  /** Stated when `available` is false; null when it is true. */
  readonly unavailableReason: RetrievalUnavailableReason | null;
  retrieve(input: {
    readable: readonly SearchDocument[];
    terms: readonly string[];
    match: TermMatch;
  }): SearchDocument[];
}

/**
 * Deterministic order: newest canonical timestamp first, then the source
 * registry's order, then document id. Stated rather than implied, because
 * "relevance" here is an ORDER, never a score.
 */
export const SEARCH_ORDERING_STATEMENT =
  'Documents matching MORE of your applied terms come first; then newest canonical timestamp; then the ' +
  'source registry order; then document id. The leading key is a COUNT over your own query — the same ' +
  'number published as `matchedTerms` on every hit, which you can check against the snippet beside it. ' +
  'It is not a relevance score, ranking weight, confidence or percentage: this surface has none of those, ' +
  'and under all-terms matching every hit shares the same count, so the order degenerates to newest-first.';

const SOURCE_ORDER = new Map<SearchSourceId, number>(SEARCH_SOURCES.map((id, index) => [id, index]));

/**
 * The one deterministic order, used by search and by Ask Jenify alike.
 *
 * Total: every tie is broken by document id, so the same corpus and the same
 * query produce a byte-identical sequence on every call and after a restart.
 */
export function orderDocuments(
  documents: readonly SearchDocument[],
  terms: readonly string[] = [],
): SearchDocument[] {
  const matchCount = new Map<string, number>(
    documents.map((doc) => [doc.id, terms.length === 0 ? 0 : matchedTermsOf(doc, terms).length]),
  );
  return [...documents].sort((a, b) => {
    const byMatches = (matchCount.get(b.id) ?? 0) - (matchCount.get(a.id) ?? 0);
    if (byMatches !== 0) return byMatches;
    const byTime = b.at.localeCompare(a.at);
    if (byTime !== 0) return byTime;
    const bySource = (SOURCE_ORDER.get(a.source) ?? 0) - (SOURCE_ORDER.get(b.source) ?? 0);
    if (bySource !== 0) return bySource;
    return a.id.localeCompare(b.id);
  });
}

/**
 * The ONE installed adapter: the existing dependency-free inverted index.
 *
 * AND semantics (every term must appear somewhere in the document) come from
 * `archive/search.ts` unchanged. This adapter neither loosens nor scores them.
 */
export const LEXICAL_RETRIEVAL_ADAPTER: RetrievalAdapter = {
  id: 'hq.retrieval.lexical',
  mode: 'deterministic_lexical',
  available: true,
  unavailableReason: null,
  retrieve({ readable, terms, match }) {
    if (terms.length === 0) return orderDocuments(readable, terms);
    const byProjectedId = new Map(readable.map((doc) => [doc.id, doc]));
    const index: ArchiveSearchIndex = buildIndex(readable.map(asArchiveProjection));
    // `all_terms` is one AND query. `any_term` is the union of one AND query
    // per term — the SAME engine call, run once per term, so there is still
    // exactly one index implementation in this repository.
    const queries = match === 'all_terms' ? [terms.join(' ')] : terms.map((term) => term);
    const matched = new Map<string, SearchDocument>();
    for (const text of queries) {
      for (const hit of searchArchiveIndex(index, { text })) {
        const doc = byProjectedId.get(hit.record.id);
        if (doc) matched.set(doc.id, doc);
      }
    }
    return orderDocuments([...matched.values()], terms);
  },
};

/**
 * Semantic adapters installed in this build: none, deliberately.
 *
 * Empty is the correct outcome of this phase, not a stub. Every semantic
 * retriever worth having is either a paid API or a model download plus
 * compute, and both are Founder-gated spend decisions. The boundary above
 * exists so that decision can be taken later without redesigning search;
 * until it is taken, a semantic request is answered by the deterministic
 * adapter and told so.
 */
export const SEMANTIC_RETRIEVAL_ADAPTERS: readonly RetrievalAdapter[] = [];

/** What actually answered, what was asked for, and why they differ. */
export interface RetrievalStatement {
  /** The mode that ACTUALLY answered. */
  mode: RetrievalMode;
  adapterId: string;
  /** The mode the caller asked for. */
  requested: RetrievalMode;
  /** Null when `mode === requested`; otherwise why the request could not be honoured. */
  fallbackReason: RetrievalUnavailableReason | null;
  note: string;
}

/**
 * Resolve the adapter for a requested mode. Never throws and never activates
 * anything: an unavailable mode falls back to the deterministic adapter and
 * the fallback is stated on every response that used it.
 */
export function resolveRetrievalAdapter(requested: RetrievalMode = 'deterministic_lexical'): {
  adapter: RetrievalAdapter;
  statement: RetrievalStatement;
} {
  if (requested === 'deterministic_lexical') {
    return {
      adapter: LEXICAL_RETRIEVAL_ADAPTER,
      statement: {
        mode: 'deterministic_lexical',
        adapterId: LEXICAL_RETRIEVAL_ADAPTER.id,
        requested,
        fallbackReason: null,
        note:
          'Answered by the local dependency-free inverted index over canonical rows. Every query term ' +
          'must appear in a document for it to be retrieved.',
      },
    };
  }
  const candidate = SEMANTIC_RETRIEVAL_ADAPTERS.find((adapter) => adapter.available) ?? null;
  if (candidate) {
    return {
      adapter: candidate,
      statement: {
        mode: candidate.mode,
        adapterId: candidate.id,
        requested,
        fallbackReason: null,
        note: 'Answered by an installed semantic retrieval adapter.',
      },
    };
  }
  const reason: RetrievalUnavailableReason =
    SEMANTIC_RETRIEVAL_ADAPTERS[0]?.unavailableReason ?? 'no_adapter_installed';
  return {
    adapter: LEXICAL_RETRIEVAL_ADAPTER,
    statement: {
      mode: 'deterministic_lexical',
      adapterId: LEXICAL_RETRIEVAL_ADAPTER.id,
      requested,
      fallbackReason: reason,
      note:
        'Semantic retrieval was requested and no semantic adapter is installed on this deployment, so the ' +
        'deterministic local index answered instead. Nothing external was contacted and nothing was activated.',
    },
  };
}

/* ------------------------------------------------------------------ */
/* Projection into the existing archive index                          */
/* ------------------------------------------------------------------ */

/**
 * Project a corpus document into the existing `ArchiveRecord` shape so
 * `archive/search.ts` indexes it unchanged — the same reuse `memory/store.ts`
 * makes through `asArchiveRecord`. Phase 11 implements NO second index.
 *
 * `category` carries the source id and `status` a coarse archive status, so
 * the archive engine's own structured filters keep working over the wider
 * corpus without a parallel filter language.
 */
export function asArchiveProjection(document: SearchDocument): ArchiveRecord {
  const status: ArchiveStatus = document.lifecycle === 'superseded' ? 'SUPERSEDED' : 'CURRENT';
  return {
    id: document.id,
    title: document.title,
    project: document.project,
    category: document.source,
    created: { date: document.at, confidence: 'exact' },
    evidence: { date: document.at, confidence: 'exact' },
    version: document.lifecycle,
    status,
    predecessorId: null,
    successorIds: [],
    related: {},
    sourceRef: `hq://${document.source}/${document.entityId}`,
    summary: `${document.body} ${document.status} ${document.entityId}`,
    tags: document.tags,
  };
}

/* ------------------------------------------------------------------ */
/* Query                                                               */
/* ------------------------------------------------------------------ */

export interface CompanySearchQuery {
  text?: string;
  sources?: readonly SearchSourceId[];
  /** Free-text project LABEL, matched exactly against the document's label. */
  project?: string;
  tag?: string;
  /** ISO year prefix over the document's canonical timestamp. */
  year?: string;
  /** Clamped to [1, SEARCH_READ_LIMIT]. */
  limit?: number;
  /** Which retrieval mode to ask for. Falls back, stated, when unavailable. */
  retrieval?: RetrievalMode;
}

export type QueryNormalization =
  | { ok: true; terms: string[]; ignoredTerms: string[]; criteria: string[] }
  | { ok: false; message: string };

/**
 * Normalize a query into terms plus stated criteria, or refuse it.
 *
 * A query with no text AND no structured filter is REFUSED — answering it
 * would be a bounded dump of the company record with no question behind it,
 * and "bounded" is not the same as "asked for". This is the enforcement point
 * for the phase's no-unbounded-dump rule.
 *
 * Terms come from the existing `tokenize`, so a query is reduced to
 * `[a-z0-9]+` runs of length > 1. That is also, incidentally, why query text
 * cannot carry an instruction: punctuation, quotes, braces, colons and
 * newlines do not survive tokenization, and a surviving word is only ever a
 * term to match. Nothing downstream interprets a term.
 */
export function normalizeSearchQuery(query: CompanySearchQuery): QueryNormalization {
  const text = (query.text ?? '').trim();
  if (text.length > MAX_QUERY_TEXT_LENGTH) {
    return { ok: false, message: `text exceeds ${MAX_QUERY_TEXT_LENGTH} characters` };
  }
  const project = (query.project ?? '').trim();
  const tag = (query.tag ?? '').trim();
  const year = (query.year ?? '').trim();
  const sources = query.sources ?? [];
  for (const source of sources) {
    if (!isSearchSource(source)) return { ok: false, message: `unknown search source: ${String(source)}` };
  }
  if (year !== '' && !/^\d{4}$/.test(year)) {
    return { ok: false, message: 'year must be a four-digit year' };
  }
  // Stopwords first, then the cap — so the cap spends its budget on words that
  // can actually match a canonical row. Everything removed is reported back.
  const tokens = tokenize(text);
  const meaningful = tokens.filter((token) => !QUERY_STOPWORDS.has(token));
  const terms = meaningful.slice(0, MAX_QUERY_TERMS);
  const applied = new Set(terms);
  const ignoredTerms = tokens.filter((token) => !applied.has(token));
  const criteria: string[] = [];
  if (terms.length > 0) criteria.push(`terms: ${terms.join(' ')}`);
  if (sources.length > 0) criteria.push(`sources: ${[...sources].sort().join(', ')}`);
  if (project !== '') criteria.push(`project label: ${project}`);
  if (tag !== '') criteria.push(`tag: ${tag}`);
  if (year !== '') criteria.push(`year: ${year}`);
  if (criteria.length === 0) {
    return {
      ok: false,
      message:
        'Supply at least one search criterion (text, source, project, tag or year). HQ does not answer a ' +
        'query with no criterion: that is a dump of the company record, not a search.',
    };
  }
  return { ok: true, terms, ignoredTerms, criteria };
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/** The browser-safe projection of a document. Absent by shape: the full body. */
export interface SearchDocumentView {
  id: string;
  source: SearchSourceId;
  entityId: string;
  table: string;
  title: string;
  status: string;
  lifecycle: SearchLifecycle;
  truthState: TruthState | null;
  privacy: MemoryPrivacy;
  at: string;
  project: string;
  tags: string[];
  evidenceRefs: string[];
  refs: SearchEntityRef[];
}

export function searchDocumentView(document: SearchDocument): SearchDocumentView {
  return {
    id: document.id,
    source: document.source,
    entityId: document.entityId,
    table: document.table,
    title: document.title,
    status: document.status,
    lifecycle: document.lifecycle,
    truthState: document.truthState,
    privacy: document.privacy,
    at: document.at,
    project: document.project,
    tags: document.tags,
    evidenceRefs: document.evidenceRefs,
    refs: document.refs,
  };
}

export interface SearchHitView {
  document: SearchDocumentView;
  /** Which query terms this document genuinely matched. Not a score. */
  matchedTerms: string[];
  /** A bounded excerpt of the canonical body around the first matched term. */
  snippet: string;
  /** Stated on every superseded hit, so a stale row is never read as current. */
  stale: boolean;
}

export interface CompanySearchView {
  searchedAt: string;
  /** The criteria that were actually applied, echoed back. */
  criteria: string[];
  terms: string[];
  /**
   * Tokens from the query that were NOT applied — stopwords, and anything
   * beyond MAX_QUERY_TERMS. Reported so the reader can see exactly what HQ
   * did to their words.
   */
  ignoredTerms: string[];
  /** How the applied terms were matched against a document. */
  match: TermMatch;
  hits: SearchHitView[];
  /** Matching documents in the READABLE set. `hits.length` is the bounded page. */
  total: number;
  truncated: boolean;
  limit: number;
  /** Per-source presence and readable size — absence is observed, never inferred. */
  sources: SearchSourceStatus[];
  /**
   * Classified documents this reader may not search, over the WHOLE corpus.
   * Query-independent by design: a per-query withheld count would let a reader
   * probe the private record one term at a time.
   */
  withheldFounderOnly: number;
  retrieval: RetrievalStatement;
  ordering: string;
  provenance: string;
}

export const SEARCH_PROVENANCE =
  'Derived at read time from the canonical stores named in each hit’s `table`, through the existing ' +
  'archive inverted index. Nothing is stored: no index table, no query log, no result cache. Search ' +
  'writes nothing and grants nothing.';

/** The one snippet rule, so every surface quotes a document the same way. */
export function snippetOf(document: SearchDocument, terms: readonly string[]): string {
  const body = document.body.replace(/\s+/g, ' ').trim();
  if (body === '') return '';
  if (body.length <= MAX_SNIPPET_LENGTH) return body;
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return `${body.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
  const start = Math.max(0, at - Math.floor(MAX_SNIPPET_LENGTH / 3));
  const slice = body.slice(start, start + MAX_SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${slice}${start + MAX_SNIPPET_LENGTH < body.length ? '…' : ''}`;
}

/** Which of the query terms genuinely occur in this document's indexed text. */
export function matchedTermsOf(document: SearchDocument, terms: readonly string[]): string[] {
  const haystack = new Set(
    tokenize(
      [document.title, document.body, document.project, document.source, document.status, document.entityId, ...document.tags].join(
        ' ',
      ),
    ),
  );
  return terms.filter((term) => haystack.has(term));
}

/**
 * Run one search over a corpus for one reader.
 *
 * Order of operations is load-bearing and is the same order every Phase 11
 * surface uses:
 *   1. split the corpus by the READER's disclosure right (never by the query);
 *   2. count the classified remainder once, corpus-wide;
 *   3. apply the structured filters, then the adapter's term retrieval;
 *   4. bound the page, stating the true readable total beside it.
 */
export function runCompanySearch(input: {
  corpus: SearchCorpus;
  query: CompanySearchQuery;
  terms: readonly string[];
  ignoredTerms: readonly string[];
  criteria: readonly string[];
  includeFounderOnly: boolean;
  now: string;
}): CompanySearchView {
  const { corpus, query, terms, includeFounderOnly } = input;

  // (1) + (2): the reader's set, and the query-independent withheld count.
  const readable = includeFounderOnly
    ? [...corpus.documents]
    : corpus.documents.filter((doc) => doc.privacy !== 'founder_only');
  const withheldFounderOnly = corpus.documents.length - readable.length;

  // (3): structured filters first — cheap, and they narrow what an adapter
  // ever sees.
  const sources = new Set(query.sources ?? []);
  const project = (query.project ?? '').trim();
  const tag = (query.tag ?? '').trim();
  const year = (query.year ?? '').trim();
  const filtered = readable.filter((doc) => {
    if (sources.size > 0 && !sources.has(doc.source)) return false;
    if (project !== '' && doc.project !== project) return false;
    if (tag !== '' && !doc.tags.includes(tag)) return false;
    if (year !== '' && !doc.at.startsWith(year)) return false;
    return true;
  });

  const { adapter, statement } = resolveRetrievalAdapter(query.retrieval ?? 'deterministic_lexical');
  // An EXPLICIT search means every word the Founder typed: `all_terms`.
  const match: TermMatch = 'all_terms';
  const matched = adapter.retrieve({ readable: filtered, terms, match });

  // (4): bound, and state the true readable total.
  const limit = Math.min(Math.max(query.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_READ_LIMIT);
  const page = matched.slice(0, limit);

  return {
    searchedAt: input.now,
    criteria: [...input.criteria],
    terms: [...terms],
    ignoredTerms: [...input.ignoredTerms],
    match,
    hits: page.map((document) => ({
      document: searchDocumentView(document),
      matchedTerms: matchedTermsOf(document, terms),
      snippet: snippetOf(document, terms),
      stale: document.lifecycle === 'superseded',
    })),
    total: matched.length,
    truncated: matched.length > page.length,
    limit,
    sources: sourceStatuses(corpus, readable),
    withheldFounderOnly,
    retrieval: statement,
    ordering: SEARCH_ORDERING_STATEMENT,
    provenance: SEARCH_PROVENANCE,
  };
}

/** Per-source presence and readable size. Counts span the reader's set only. */
export function sourceStatuses(
  corpus: SearchCorpus,
  readable: readonly SearchDocument[],
): SearchSourceStatus[] {
  const presentById = new Map(corpus.sources.map((entry) => [entry.id, entry.storePresent]));
  const counts = new Map<SearchSourceId, number>();
  for (const doc of readable) counts.set(doc.source, (counts.get(doc.source) ?? 0) + 1);
  return SEARCH_SOURCES.map((id) => ({
    id,
    table: searchSourceDescriptor(id).table,
    storePresent: presentById.get(id) ?? false,
    readableDocuments: counts.get(id) ?? 0,
  }));
}

/* ------------------------------------------------------------------ */
/* Ask Jenify                                                          */
/* ------------------------------------------------------------------ */

export const ANSWER_STATES = ['grounded', 'insufficient_evidence', 'unknown'] as const;
export type AnswerState = (typeof ANSWER_STATES)[number];

export const ANSWER_UNKNOWN_REASONS = [
  /** The question carried no term the index could match. */
  'no_searchable_terms',
  /** Retrieval ran and matched no canonical row the reader may see. */
  'no_matching_canonical_record',
  /** This database handle carries none of the stores the question would need. */
  'no_source_store_present',
] as const;
export type AnswerUnknownReason = (typeof ANSWER_UNKNOWN_REASONS)[number];

/**
 * Every limitation an answer can carry. Categorical so a reader can act on
 * them, and exhaustive so an answer never quietly omits one.
 */
export const ANSWER_LIMITATIONS = [
  'lexical_retrieval_only',
  'bounded_retrieval',
  'terms_ignored',
  'superseded_records_cited',
  'unverified_truth_cited',
  'no_truth_record_cited',
  'no_evidence_cited',
  'founder_only_not_searched',
  'stores_absent',
  'composed_from_fields_only',
] as const;
export type AnswerLimitationCode = (typeof ANSWER_LIMITATIONS)[number];

export interface AnswerLimitation {
  code: AnswerLimitationCode;
  statement: string;
}

export interface AnswerCitation {
  /** The retrieved document, in the same projection search publishes. */
  document: SearchDocumentView;
  matchedTerms: string[];
  snippet: string;
  stale: boolean;
}

export interface AskAnswerView {
  /** The question as asked, echoed verbatim so the answer is self-describing. */
  question: string;
  askedAt: string;
  state: AnswerState;
  /** Set only when `state` is not `grounded`. */
  unknownReason: AnswerUnknownReason | null;
  /**
   * The composed response. Every clause is a count or a categorical field of
   * a cited row; no clause asserts anything the citations do not carry.
   */
  response: string;
  citations: AnswerCitation[];
  /** Matching readable documents in total; `citations.length` is what was read. */
  considered: number;
  terms: string[];
  /** Query words that were not applied — stopwords and anything over the cap. */
  ignoredTerms: string[];
  /** How the applied terms were matched. A question uses `any_term`. */
  match: TermMatch;
  /** Phase 7 standing across the CITED truth records only. */
  truth: {
    cited: number;
    byState: Record<TruthState, number>;
    /** The strongest state present among cited truth records; null when none. */
    strongest: TruthState | null;
  };
  sources: SearchSourceStatus[];
  withheldFounderOnly: number;
  retrieval: RetrievalStatement;
  limitations: AnswerLimitation[];
  ordering: string;
  provenance: string;
}

export const ASK_PROVENANCE =
  'Retrieval ran FIRST over canonical rows; the response was then composed from fields of the retrieved ' +
  'rows only, by stated code. No language model was called, nothing was inferred beyond the counts and ' +
  'categorical states shown, and nothing was written.';

/** Strongest-first, so "what is the best-established state cited" has one answer. */
const TRUTH_STRENGTH: readonly TruthState[] = ['accepted', 'verified', 'observed', 'claimed'];

function emptyTruthCounts(): Record<TruthState, number> {
  return Object.fromEntries(TRUTH_STATES.map((state) => [state, 0])) as Record<TruthState, number>;
}

const LIMITATION_TEXT: Record<AnswerLimitationCode, string> = {
  lexical_retrieval_only:
    'Retrieval matched query terms literally. A canonical record that states the same thing in different ' +
    'words was not retrieved, and its absence here is not evidence that it does not exist.',
  bounded_retrieval:
    'More records matched than were read. The answer describes only the records cited below.',
  terms_ignored:
    'Some words in the question were not used as search terms: common English words from a stated, closed ' +
    'stopword list, and anything beyond the term cap. They are listed on the answer as ignoredTerms.',
  superseded_records_cited:
    'At least one cited record has been superseded. It is labelled stale and is shown because it matched, ' +
    'not because it is current.',
  unverified_truth_cited:
    'At least one cited truth record stands at claimed or observed. Those states are recorded assertions, ' +
    'not verified facts.',
  no_truth_record_cited:
    'No truth record was cited, so nothing in this answer carries a Phase 7 verification state.',
  no_evidence_cited: 'No cited record names an op_evidence entry, so this answer has no evidence chain behind it.',
  founder_only_not_searched:
    'Founder-classified records exist in the company record and were not searched for this reader. The ' +
    'number stated is a property of the corpus, not of this question.',
  stores_absent:
    'At least one canonical store is absent from this database handle, so records of that kind could not ' +
    'be searched at all. Absence was observed, not treated as zero.',
  composed_from_fields_only:
    'This response was composed from fields of the cited rows by stated code. It contains no summary, ' +
    'opinion, inference or generated prose.',
};

function limitation(code: AnswerLimitationCode): AnswerLimitation {
  return { code, statement: LIMITATION_TEXT[code] };
}

/**
 * Compose the answer sentence from the cited rows.
 *
 * Every clause here is a COUNT over the citations or a categorical field of
 * one of them. There is deliberately no template that interpolates a row's
 * free text into a sentence: the text lives in the citation's snippet, where
 * it is unambiguously a quotation of a named canonical row rather than HQ's
 * own words.
 */
export function composeAnswerText(input: {
  citations: readonly AnswerCitation[];
  considered: number;
  truthByState: Record<TruthState, number>;
}): string {
  const { citations, considered } = input;
  if (citations.length === 0) return '';
  const bySource = new Map<SearchSourceId, number>();
  for (const citation of citations) {
    bySource.set(citation.document.source, (bySource.get(citation.document.source) ?? 0) + 1);
  }
  const sourceParts = SEARCH_SOURCES.filter((id) => (bySource.get(id) ?? 0) > 0).map(
    (id) => `${id} ${bySource.get(id)}`,
  );
  const sentences: string[] = [
    `Answered from ${citations.length} canonical record${citations.length === 1 ? '' : 's'} ` +
      `(${sourceParts.join(', ')}), out of ${considered} that matched.`,
  ];
  const truthParts = TRUTH_STRENGTH.filter((state) => input.truthByState[state] > 0).map(
    (state) => `${state} ${input.truthByState[state]}`,
  );
  if (truthParts.length > 0) {
    sentences.push(`Cited truth records stand at: ${truthParts.join(', ')}.`);
  } else {
    sentences.push('No cited record carries a truth state.');
  }
  const stale = citations.filter((citation) => citation.stale).length;
  sentences.push(
    stale === 0
      ? 'No cited record has been superseded.'
      : `${stale} cited record${stale === 1 ? ' has' : 's have'} been superseded and ${
          stale === 1 ? 'is' : 'are'
        } labelled stale.`,
  );
  const evidence = citations.filter((citation) => citation.document.evidenceRefs.length > 0).length;
  sentences.push(
    evidence === 0
      ? 'No cited record names an op_evidence entry.'
      : `${evidence} cited record${evidence === 1 ? ' names' : 's name'} op_evidence entries.`,
  );
  sentences.push('Each cited record is listed below with the canonical table and id it came from.');
  return sentences.join(' ');
}

const UNKNOWN_TEXT: Record<AnswerUnknownReason, string> = {
  no_searchable_terms:
    'HQ could not answer this: the question carried no term the canonical index can match. Nothing was ' +
    'guessed and nothing was retrieved.',
  no_matching_canonical_record:
    'HQ holds no canonical record matching this question, so there is no grounded answer to give. This ' +
    'states what the company record contains — it is not a statement that the thing asked about is false.',
  no_source_store_present:
    'This database handle carries none of the canonical stores this question would be answered from, so ' +
    'nothing could be searched. Absence was observed, not read as an empty answer.',
};

/**
 * Assemble one answer. Pure over the retrieval result the facade supplies —
 * this function has no database handle, no identity and no capability, which
 * is the structural reason an answer can neither widen disclosure nor act.
 */
export function assembleAnswer(input: {
  question: string;
  askedAt: string;
  terms: readonly string[];
  ignoredTerms: readonly string[];
  match: TermMatch;
  /** Already privacy-filtered, already ordered, already bounded by the facade. */
  retrieved: readonly SearchDocument[];
  /** Total readable matches before bounding. */
  considered: number;
  sources: SearchSourceStatus[];
  withheldFounderOnly: number;
  retrieval: RetrievalStatement;
  /** True when every source store this handle could carry is absent. */
  noStorePresent: boolean;
}): AskAnswerView {
  const citations: AnswerCitation[] = input.retrieved.map((document) => ({
    document: searchDocumentView(document),
    matchedTerms: matchedTermsOf(document, input.terms),
    snippet: snippetOf(document, input.terms),
    stale: document.lifecycle === 'superseded',
  }));

  const byState = emptyTruthCounts();
  for (const document of input.retrieved) {
    if (document.truthState) byState[document.truthState] += 1;
  }
  const strongest = TRUTH_STRENGTH.find((state) => byState[state] > 0) ?? null;
  const truthCited = input.retrieved.filter((document) => document.truthState !== null).length;

  let state: AnswerState;
  let unknownReason: AnswerUnknownReason | null;
  if (citations.length > 0) {
    state = 'grounded';
    unknownReason = null;
  } else if (input.noStorePresent) {
    state = 'unknown';
    unknownReason = 'no_source_store_present';
  } else if (input.terms.length === 0) {
    state = 'unknown';
    unknownReason = 'no_searchable_terms';
  } else {
    state = 'insufficient_evidence';
    unknownReason = 'no_matching_canonical_record';
  }

  const limitations: AnswerLimitation[] = [limitation('composed_from_fields_only')];
  if (input.retrieval.mode === 'deterministic_lexical') limitations.push(limitation('lexical_retrieval_only'));
  if (input.ignoredTerms.length > 0) limitations.push(limitation('terms_ignored'));
  if (input.considered > citations.length) limitations.push(limitation('bounded_retrieval'));
  if (citations.some((citation) => citation.stale)) limitations.push(limitation('superseded_records_cited'));
  if (byState.claimed > 0 || byState.observed > 0) limitations.push(limitation('unverified_truth_cited'));
  if (citations.length > 0 && truthCited === 0) limitations.push(limitation('no_truth_record_cited'));
  if (citations.length > 0 && citations.every((citation) => citation.document.evidenceRefs.length === 0)) {
    limitations.push(limitation('no_evidence_cited'));
  }
  if (input.withheldFounderOnly > 0) limitations.push(limitation('founder_only_not_searched'));
  if (input.sources.some((source) => !source.storePresent)) limitations.push(limitation('stores_absent'));

  return {
    question: input.question,
    askedAt: input.askedAt,
    state,
    unknownReason,
    response:
      state === 'grounded'
        ? composeAnswerText({ citations, considered: input.considered, truthByState: byState })
        : UNKNOWN_TEXT[unknownReason!],
    citations,
    considered: input.considered,
    terms: [...input.terms],
    ignoredTerms: [...input.ignoredTerms],
    match: input.match,
    truth: { cited: truthCited, byState, strongest },
    sources: input.sources,
    withheldFounderOnly: input.withheldFounderOnly,
    retrieval: input.retrieval,
    limitations,
    ordering: SEARCH_ORDERING_STATEMENT,
    provenance: ASK_PROVENANCE,
  };
}

/* ------------------------------------------------------------------ */
/* The snapshot section                                                */
/* ------------------------------------------------------------------ */

/**
 * What the UNAUTHENTICATED artifact may say about search.
 *
 * Deliberately no text of any kind: no title, no snippet, no id, no term, no
 * question and no result. The section states only which sources EXIST on the
 * built handle, how many documents an unauthenticated reader could search,
 * how many classified documents were not searched, and which retrieval mode
 * answers. That is the same disclosure the Phase 5/7/9 sections already make
 * (a count plus a withheld count) and strictly less than any of them, because
 * those carry records and this carries none.
 */
export interface SearchIndexSnapshotView {
  sources: SearchSourceStatus[];
  /** Documents an unauthenticated reader could search. Never spans withheld rows. */
  readableTotal: number;
  /** Classified documents excluded from that total. Corpus-wide, query-independent. */
  withheldFounderOnly: number;
  retrieval: RetrievalStatement;
  note: string;
}

export const SEARCH_SNAPSHOT_NOTE =
  'The search source registry only. This artifact carries no document, title, snippet, id, term, question ' +
  'or result — search and Ask Jenify are Founder-gated reads and nothing they return is published here.';
