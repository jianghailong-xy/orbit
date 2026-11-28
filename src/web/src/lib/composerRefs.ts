/**
 * `#`- and `@`-references in the composer: `@` names one of your sessions, `#` a project, a task,
 * a list or a Drive file (docs/composer-references-design.md, revision 3).
 *
 * The composer is a real `<textarea>`, so a chip cannot live inside it. What renders the chip is
 * a mirror layer painted underneath with identical metrics — which constrains this design more
 * than it looks: the mirror may change colour and background, but **not the characters or their
 * widths**. Change either and the caret drifts away from the glyph the user sees, further with
 * every chip.
 *
 * That rules out carrying `[Title](orbit-list:<uuid>)` in the box and hiding the uuid behind a
 * chip — the first thing tried, and it looked perfect until the textarea's own text was made
 * visible on top of the mirror, at which point 74 characters were sitting under a 25-character
 * pill.
 *
 * So the box holds a short `#<title>` the user can read, this module remembers which id that
 * title was picked for, and the full markdown link is materialised on send. The wire format is
 * unchanged; only what the person looks at is.
 */

export type ReferenceKind = 'list' | 'task' | 'drive' | 'session' | 'project';

export interface PickedReference {
  kind: ReferenceKind;
  id: string;
  /** A drive file's `/home/orbit/Drive/…` path: what is sent in place of its chip. */
  path?: string;
}

/** Tokens the user has picked, keyed by the exact text inserted after the `#` or `@`. */
export type ReferenceMap = Readonly<Record<string, PickedReference>>;

/** Escape a token for use inside a RegExp. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The symbol a kind is typed with: a session is who did the work, everything else what it is about. */
export type ReferenceSigil = '#' | '@';
export const sigilOf = (kind: ReferenceKind): ReferenceSigil => (kind === 'session' ? '@' : '#');

/**
 * A matcher for the recorded tokens, longest first.
 *
 * Longest-first is what makes titles that are prefixes of each other resolve to the one actually
 * picked — this deployment has `[W 009/250] …` and `[W 009/250] … → WARC` side by side, and
 * shortest-match would silently reference the wrong task.
 *
 * Returns null when nothing has been picked, so callers can skip the walk entirely.
 */
function tokenMatcher(refs: ReferenceMap): RegExp | null {
  const tokens = Object.keys(refs).sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return null;
  // Each token with its own kind's symbol, so `@Deploy` matches a picked session and `#Deploy` a
  // picked project, and neither matches the other.
  return new RegExp(`(${tokens.map((t) => escapeRe(sigilOf(refs[t].kind) + t)).join('|')})`, 'g');
}

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'ref'; text: string; kind: ReferenceKind };

/**
 * Split `text` into the runs the mirror paints.
 *
 * Every segment's `text` concatenates back to the input exactly — that identity is what keeps the
 * mirror aligned with the textarea, and it is the invariant worth testing above all others here.
 */
export function segmentComposer(text: string, refs: ReferenceMap): Segment[] {
  const spans: Array<{ start: number; end: number; seg: Segment }> = [];
  const matcher = tokenMatcher(refs);
  if (matcher) {
    for (const m of text.matchAll(matcher)) {
      const ref = refs[m[1].slice(1)];
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        seg: { type: 'ref', text: m[0], kind: ref.kind },
      });
    }
  }

  const out: Segment[] = [];
  let at = 0;
  for (const s of spans) {
    // The matcher is one longest-first alternation, so its matches never overlap; an `@` inside a
    // picked title is part of that title, not a reference of its own.
    if (s.start < at) continue;
    if (s.start > at) out.push({ type: 'text', text: text.slice(at, s.start) });
    out.push(s.seg);
    at = s.end;
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
  return out;
}

/**
 * Turn `#<title>` and `@<title>` back into the markdown links the server expands.
 *
 * A token the user has since edited simply no longer matches anything recorded, so it travels as
 * the literal text they typed: the reference quietly does not expand, which is the failure mode
 * worth having — nothing is sent that they cannot see, and nothing errors.
 */
export function materializeReferences(text: string, refs: ReferenceMap): string {
  const matcher = tokenMatcher(refs);
  if (!matcher) return text;
  return text.replace(matcher, (whole, written: string) => {
    const token = written.slice(1);
    const ref = refs[token];
    if (!ref) return whole;
    // A drive file goes out as its path, which a Cloud agent reads from its mount (design §4.5).
    if (ref.kind === 'drive' && ref.path) return ref.path;
    // Brackets in the title are escaped, not passed through: this deployment's task titles start
    // with `[W 009/250]`, and an unescaped one closes the link text early — the server still
    // expands it (it matches on the URI), but the user's own bubble renders the markdown, so the
    // broken link puts a raw uuid in front of the person who never typed one.
    const label = token.replace(/[[\]]/g, '\\$&');
    return `[${label}](orbit-${ref.kind}:${ref.id})`;
  });
}

/**
 * Record a pick and return the text with `#<title> ` inserted in place of the `#query` being
 * typed.
 *
 * Only the trailing `#token` is replaced, so picking a reference mid-message leaves earlier text
 * alone — the same rule the `@` menu follows.
 *
 * A title picked twice for different ids keeps the newer one: the map is keyed by what the user
 * can see, and two rows reading identically are not distinguishable in the box either. This
 * deployment has 43 lists whose tasks share titles, so it is a real case rather than a
 * theoretical one; the cost is that the older of two identically-named picks re-points, which is
 * visible in the composer and harmless on the wire.
 */
export function applyReferencePick(
  text: string,
  title: string,
  ref: PickedReference,
  refs: ReferenceMap,
): { text: string; refs: ReferenceMap } {
  const sigil = sigilOf(ref.kind);
  return {
    // `[^#@\n]*`, not `[^\n]*`: the greedy form reaches back past an earlier sigil in the same
    // line and swallows the text between them. A replacer, not a pattern string, so a `$` in a
    // title is a `$` and not a substitution.
    text: text.replace(queryRe(sigil), (_whole, lead: string) => `${lead}${sigil}${title} `),
    refs: { ...refs, [title]: ref },
  };
}

/** The `#` (or `@`) query being typed at the caret, or null when the menu should stay closed. */
export function referenceToken(text: string, sigil: ReferenceSigil = '#'): string | null {
  // Anything up to the end of the line: titles contain spaces, so stopping at the first one
  // would make every multi-word title unsearchable past its first word.
  // Stops at an earlier sigil for the same reason applyReferencePick does — the two must agree
  // on where the query starts or the pick replaces a different span than the menu searched.
  return queryRe(sigil).exec(text)?.[2] ?? null;
}

/**
 * The query at the end of the draft: the sigil at the start or after whitespace, then the rest of
 * the line up to the other sigil. Stopping at either one is what lets `#Runner link with @depl` open
 * the `@` menu alone: whichever was typed last is the one being typed.
 */
function queryRe(sigil: ReferenceSigil): RegExp {
  return sigil === '#' ? /(^|\s)#([^#@\n]*)$/ : /(^|\s)@([^#@\n]*)$/;
}
