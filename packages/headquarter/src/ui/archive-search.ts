/**
 * Archive search semantics (issue #138, page 8).
 *
 * The Archive page ships a small client-side script so the Founder can filter
 * a fully static page. Historically that script duplicated the matching rules
 * inline, which is how search and the Evolution section drifted apart: search
 * hid table rows, Evolution ignored the query entirely.
 *
 * These functions are now the ONE definition of the semantics. They are plain,
 * self-contained functions (no imports, no closures, no module state) so the
 * exact same source is:
 *   - unit-tested directly in `test/archive-search.test.ts`, and
 *   - serialized into the page via `Function.prototype.toString()`.
 *
 * If you change a rule here, both the tests and the browser change together.
 * Do not re-inline a second copy of the matching logic.
 */

/** The searchable projection of one archive record, embedded as JSON. */
export interface ArchiveSearchRow {
  id: string;
  /** Lower-cased title — matched with a weight bonus. */
  title: string;
  /** Lower-cased title + summary + project + category + tags. */
  text: string;
  project: string;
  category: string;
  status: string;
  /** YYYY of the record's created date. */
  year: string;
}

export interface ArchiveFilters {
  project: string;
  category: string;
  status: string;
  year: string;
}

export const EMPTY_FILTERS: ArchiveFilters = { project: '', category: '', status: '', year: '' };

/**
 * Split free text into searchable tokens: lower-cased, alphanumeric,
 * single characters dropped. Same rule as the server-side
 * `archive/search.ts` tokenizer, kept independent so this file stays
 * self-contained enough to serialize.
 */
export function archiveTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(function (token) {
      return token.length > 1;
    });
}

/**
 * AND semantics over tokens plus exact-match structured filters. An empty
 * token list and empty filters match everything, which is what makes
 * "cleared search" mean "show all" rather than "show none".
 */
export function archiveRowMatches(row: ArchiveSearchRow, tokens: string[], filters: ArchiveFilters): boolean {
  if (filters.project && row.project !== filters.project) return false;
  if (filters.category && row.category !== filters.category) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.year && row.year !== filters.year) return false;
  for (var index = 0; index < tokens.length; index += 1) {
    if (row.text.indexOf(tokens[index]) === -1) return false;
  }
  return true;
}

/**
 * Relevance for ranked results: every token scores once, and a token found in
 * the title scores three times as much as one found only in the body. Zero
 * tokens means "no ranking signal", so callers fall back to date order.
 */
export function archiveScore(row: ArchiveSearchRow, tokens: string[]): number {
  var score = 0;
  for (var index = 0; index < tokens.length; index += 1) {
    var token = tokens[index];
    if (row.title.indexOf(token) !== -1) score += 3;
    else if (row.text.indexOf(token) !== -1) score += 1;
  }
  return score;
}

/** True when the Founder has actually narrowed anything down. */
export function archiveQueryIsActive(text: string, filters: ArchiveFilters): boolean {
  return (
    archiveTokens(text).length > 0 ||
    Boolean(filters.project) ||
    Boolean(filters.category) ||
    Boolean(filters.status) ||
    Boolean(filters.year)
  );
}

/**
 * Full result set for a query: matching rows, ranked by relevance when text
 * was given and otherwise left in the caller's incoming order.
 */
export function archiveSearch(
  rows: ArchiveSearchRow[],
  text: string,
  filters: ArchiveFilters,
): ArchiveSearchRow[] {
  const tokens = archiveTokens(text);
  const matched = rows.filter((row) => archiveRowMatches(row, tokens, filters));
  if (tokens.length === 0) return matched;
  return matched
    .map((row, index) => ({ row, index, score: archiveScore(row, tokens) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.row);
}

/**
 * The browser-side controller, generated from the very functions above.
 *
 * Behaviour, stated so it is not "silently changed semantics":
 *   - No query and no filters → the chronological month browser is shown.
 *   - Any query or filter     → a ranked flat result list replaces it.
 *   - Evolution chains ALWAYS follow the same match set: non-matching entries
 *     are marked, and chains with no match at all are hidden. This is the
 *     inconsistency issue #138 asked to normalise.
 *   - The result count is announced in an aria-live region.
 *
 * The script touches only this page's own DOM: no network, no storage.
 */
export function archiveSearchScript(rows: ArchiveSearchRow[]): string {
  const data = JSON.stringify(rows).replaceAll('</', '<\\/');
  return `<script id="archive-search-data" type="application/json">${data}</script>
<script>
(function () {
  ${archiveTokens.toString()}
  ${archiveRowMatches.toString()}
  ${archiveScore.toString()}

  var rows = JSON.parse(document.getElementById('archive-search-data').textContent);
  var input = document.getElementById('archive-search');
  var selects = {
    project: document.getElementById('archive-filter-project'),
    category: document.getElementById('archive-filter-category'),
    status: document.getElementById('archive-filter-status'),
    year: document.getElementById('archive-filter-year')
  };
  var browse = document.getElementById('archive-browse');
  var results = document.getElementById('archive-results');
  var count = document.getElementById('archive-count');
  var evolution = document.getElementById('archive-evolution');
  if (!input || !browse || !results || !count) return;

  var cards = {};
  Array.prototype.forEach.call(results.querySelectorAll('[data-archive-id]'), function (el) {
    cards[el.getAttribute('data-archive-id')] = el;
  });

  function apply() {
    var filters = {
      project: selects.project ? selects.project.value : '',
      category: selects.category ? selects.category.value : '',
      status: selects.status ? selects.status.value : '',
      year: selects.year ? selects.year.value : ''
    };
    var tokens = archiveTokens(input.value);
    var active = tokens.length > 0 || filters.project || filters.category || filters.status || filters.year;

    var matched = [];
    var matchedIds = {};
    rows.forEach(function (row, index) {
      if (!archiveRowMatches(row, tokens, filters)) return;
      matchedIds[row.id] = true;
      matched.push({ row: row, index: index, score: archiveScore(row, tokens) });
    });
    if (tokens.length > 0) {
      matched.sort(function (a, b) { return b.score - a.score || a.index - b.index; });
    }

    browse.hidden = !!active;
    results.hidden = !active;

    Object.keys(cards).forEach(function (id) { cards[id].hidden = true; });
    matched.forEach(function (entry) {
      var card = cards[entry.row.id];
      if (!card) return;
      card.hidden = false;
      results.appendChild(card);
    });

    count.textContent = active
      ? matched.length + (matched.length === 1 ? ' record matches' : ' records match') + ' the current search.'
      : rows.length + ' records in the archive. Browsing chronologically.';

    if (evolution) {
      Array.prototype.forEach.call(evolution.querySelectorAll('[data-evolution-chain]'), function (chain) {
        var entries = chain.querySelectorAll('[data-evolution-entry]');
        var any = false;
        Array.prototype.forEach.call(entries, function (entry) {
          var hit = !active || matchedIds[entry.getAttribute('data-evolution-entry')] === true;
          entry.classList.toggle('is-dimmed', !hit);
          if (hit) any = true;
        });
        chain.hidden = active && !any;
      });
    }
  }

  input.addEventListener('input', apply);
  Object.keys(selects).forEach(function (key) {
    if (selects[key]) selects[key].addEventListener('change', apply);
  });
  apply();
})();
</script>`;
}
