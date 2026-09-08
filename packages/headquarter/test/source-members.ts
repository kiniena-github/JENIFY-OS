/**
 * ONE member slicer, shared by every derived guard that segments a source file
 * into its declarations (Wave 5 correction round fourteen, Medium 15).
 *
 * ## Why this file exists
 *
 * Two derived guards each carried their own copy of "split `service.ts` into
 * its members", and the copies did not agree:
 *
 *  - `facade-write-scan.test.ts` matched `/^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/`,
 *    which cannot see a member declared `async`, `static`, `get`, `set`,
 *    `private`, `protected`, `override` or `readonly`. A member it cannot see
 *    is not merely skipped: its body is folded into the PREVIOUS slice, so the
 *    previous member is credited with writes and parameters that are not its
 *    own, and the invisible member contributes nothing at all. Measured at the
 *    frozen head `3fcc271`: 249 members visible, one invisible
 *    (`get policyContext()`).
 *  - `credential-scan-coverage.test.ts` matched
 *    `/^ {2}(?:static )?(?:async )?[#a-zA-Z][\w$]*(?:<[^>]*>)?\(/`, which sees
 *    `static` and `async` but not `get`/`set`/`private`/`protected`/`override`,
 *    and kept the modifiers in the reported NAME (`async recordThing`).
 *
 * Two spellings of "the declarations of a file" is how a member that is
 * invisible to one guard and visible to the other goes unreported by both —
 * the same class of defect `facadeWriteSignatures` was extracted for inside a
 * single file (round thirteen, Low 2), one level up.
 *
 * ## What it deliberately does NOT do
 *
 * This is a source-level segmentation, not a parse. The property the guards
 * that use it assert is a property of the code AS WRITTEN — "a method that
 * writes also scans its text parameters" — and a TypeScript AST would make
 * these guards depend on the compiler's view of the code rather than on its
 * text. The trade is stated rather than hidden: a declaration this cannot
 * recognise folds into the previous slice, so the recognition set below is
 * widened whenever a new spelling appears, and `classMemberSlices` is asserted
 * against the real files in `source-members.test.ts`.
 */

/**
 * Every modifier TypeScript allows before a class member's name.
 *
 * `get`/`set` are here because an accessor is a member: `get policyContext()`
 * was the one declaration invisible to the previous facade slicer. `abstract`
 * and `declare` never appear in these files today and cost nothing to accept.
 */
export const MEMBER_MODIFIERS = [
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'async',
  'override',
  'abstract',
  'declare',
  'get',
  'set',
] as const;

/**
 * A class member declaration at two-space indentation.
 *
 * Modifiers are consumed and dropped, so the captured group is the DECLARED
 * IDENTIFIER and nothing else — `policyContext`, not `get policyContext`. Each
 * modifier must be followed by whitespace, which is what keeps a method
 * literally named `get(` (`OperatorQueue.get`) reading as the member `get`
 * rather than as a modifier with no name behind it.
 *
 * A `:` after the identifier is NOT matched, so a field declaration
 * (`readonly #getTask: (taskId: string) => OperatorTask | null;`) is correctly
 * not a member declaration for slicing purposes — its initializer lives in the
 * constructor.
 */
const MEMBER_DECLARATION = new RegExp(
  `^ {2}(?:(?:${MEMBER_MODIFIERS.join('|')})\\s+)*(#?[A-Za-z_$][\\w$]*)\\s*(?:<[^()]*>)?\\s*\\(`,
);

/** A top-level `function` / `class` declaration. */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class)\s+([#A-Za-z_$][\w$]*)/;

/** What a slice was cut from. */
export type SourceMemberKind = 'member' | 'function' | 'class' | 'module';

export interface SourceMember {
  /** The declared identifier with every modifier stripped. */
  name: string;
  /** Zero-based index of the line the declaration starts on. */
  line: number;
  /** The source from this declaration up to the line before the next one. */
  body: string;
  kind: SourceMemberKind;
}

/**
 * The identifier a line declares, or null when the line declares nothing.
 *
 * Exported so a guard can assert the recognition set directly rather than
 * inferring it from a slice count.
 */
export function memberDeclarationName(line: string): string | null {
  const match = MEMBER_DECLARATION.exec(line);
  return match ? match[1] : null;
}

/**
 * Slice a source file into its class members, from `fromLine` onwards.
 *
 * `exclude` drops the control-flow keywords that can appear at member
 * indentation inside a template literal or a wrapped call. Slices run from one
 * declaration to the next, so a body always belongs to the member that
 * declared it — which is the property the previous per-guard copies broke.
 */
export function classMemberSlices(
  source: string,
  options: { fromLine?: number; exclude?: ReadonlySet<string> } = {},
): SourceMember[] {
  const lines = source.split('\n');
  const from = options.fromLine ?? 0;
  const exclude = options.exclude ?? new Set<string>();
  const starts: { name: string; line: number }[] = [];
  for (let i = from; i < lines.length; i += 1) {
    const name = memberDeclarationName(lines[i]);
    if (name !== null && !exclude.has(name)) starts.push({ name, line: i });
  }
  return starts.map((start, k) => ({
    name: start.name,
    line: start.line,
    kind: 'member' as const,
    body: lines.slice(start.line, k + 1 < starts.length ? starts[k + 1].line : lines.length).join('\n'),
  }));
}

/**
 * Slice a whole module into its declarations: every class member AND every
 * top-level `function`/`class`, with everything before the first one kept as a
 * `<module scope>` bucket so no line of the file is dropped.
 *
 * The bucket matters: a guard that asks "does any declaration that calls X also
 * call Y" must be able to see module-level code, and losing it silently would
 * answer the question over a subset of the file.
 */
export function sourceMemberSlices(source: string): SourceMember[] {
  const lines = source.split('\n');
  const starts: { name: string; line: number; kind: SourceMemberKind }[] = [
    { name: '<module scope>', line: 0, kind: 'module' },
  ];
  lines.forEach((line, index) => {
    const top = TOP_LEVEL_DECLARATION.exec(line);
    if (top) {
      starts.push({ name: top[2], line: index, kind: top[1] === 'class' ? 'class' : 'function' });
      return;
    }
    const member = memberDeclarationName(line);
    if (member !== null) starts.push({ name: member, line: index, kind: 'member' });
  });
  return starts.map((start, k) => ({
    name: start.name,
    line: start.line,
    kind: start.kind,
    body: lines.slice(start.line, k + 1 < starts.length ? starts[k + 1].line : lines.length).join('\n'),
  }));
}
