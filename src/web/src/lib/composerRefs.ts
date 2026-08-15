/**
 * `#`-references in the composer.
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

export type ReferenceKind = 'list' | 'task';

export interface PickedReference {
  kind: ReferenceKind;
  id: string;
}

/** Tokens the user has picked, keyed by the exact text inserted after the `#`. */
export type ReferenceMap = Readonly<Record<string, PickedReference>>;

/** Escape a token for use inside a RegExp. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  return new RegExp(`#(${tokens.map(escapeRe).join('|')})`, 'g');
}

/** A `@workspace` mention. Names are restricted to this shape by the workspace form. */
const MENTION_RE = /(^|[\s(（])@([A-Za-z0-9._-]+)/g;

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'ref'; text: string; kind: ReferenceKind }
  | { type: 'mention'; text: string };

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
      const token = m[1];
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        seg: { type: 'ref', text: m[0], kind: refs[token].kind },
      });
    }
  }
  for (const m of text.matchAll(MENTION_RE)) {
    // `m[1]` is the boundary character before the `@`; it belongs to the surrounding text.
    const start = m.index + m[1].length;
    const end = start + m[2].length + 1;
    spans.push({ start, end, seg: { type: 'mention', text: text.slice(start, end) } });
  }
  spans.sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let at = 0;
  for (const s of spans) {
    // Overlaps resolve in favour of whichever span started first, which is what keeps a `@`
    // inside a reference title part of that title rather than a mention of its own — reference
    // spans always start at their `#`, ahead of any `@` within them.
    if (s.start < at) continue;
    if (s.start > at) out.push({ type: 'text', text: text.slice(at, s.start) });
    out.push(s.seg);
    at = s.end;
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
  return out;
}

/**
 * Turn `#<title>` back into the markdown link the server expands.
 *
 * A token the user has since edited simply no longer matches anything recorded, so it travels as
 * the literal text they typed: the reference quietly does not expand, which is the failure mode
 * worth having — nothing is sent that they cannot see, and nothing errors.
 */
export function materializeReferences(text: string, refs: ReferenceMap): string {
  const matcher = tokenMatcher(refs);
  if (!matcher) return text;
  return text.replace(matcher, (whole, token: string) => {
    const ref = refs[token];
    if (!ref) return whole;
    return `[${token}](orbit-${ref.kind}:${ref.id})`;
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
  return {
    // `[^#\n]*`, not `[^\n]*`: the greedy form reaches back past an earlier `#` in the same
    // line and swallows the text between them.
    text: text.replace(/(^|\s)#([^#\n]*)$/, `$1#${title} `),
    refs: { ...refs, [title]: ref },
  };
}

/** The `#` query being typed at the caret, or null when the menu should stay closed. */
export function referenceToken(text: string): string | null {
  // Anything up to the end of the line: titles contain spaces, so stopping at the first one
  // would make every multi-word list unsearchable past its first word.
  // Stops at an earlier `#` for the same reason applyReferencePick does — the two must agree
  // on where the query starts or the pick replaces a different span than the menu searched.
  return /(?:^|\s)#([^#\n]*)$/.exec(text)?.[1] ?? null;
}
