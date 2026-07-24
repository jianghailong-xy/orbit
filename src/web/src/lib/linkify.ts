// Splits a verbatim user message into literal-text and URL runs so the user bubble can render
// bare links as clickable <a> WITHOUT Markdown-parsing the text (a literal '#'/'*' the user typed
// must survive untouched — see Transcript's UserBubble). The assistant bubble already autolinks via
// remark-gfm; this mirrors that just for the user turn, which is intentionally plain.

export type LinkSegment =
  | { type: 'text'; value: string }
  | { type: 'url'; value: string; href: string };

// A URL runs from http(s):// until whitespace or '<'. It also stops at CJK punctuation and Han
// characters (U+3000–303F symbols/brackets, U+4E00–9FFF ideographs, U+FF00–FFEF full/half-width
// forms) so a link hugged by Chinese prose with no space — "…&project=i18n_1029，然后…" — doesn't
// swallow the sentence. http/https only: the common pasted-link case, and it avoids mis-linkifying
// bare words with dots.
const URL_RE = /https?:\/\/[^\s<　-〿一-鿿＀-￯]+/g;

// ASCII punctuation that almost always trails a URL in prose rather than belonging to it (a link
// ending a sentence, or wrapped in parens). CJK marks can't reach here — they're excluded from the
// match above — so this only needs the ASCII set.
const TRAILING = /[.,;:!?'")\]}>]+$/;

export function splitLinks(text: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    // Trim trailing punctuation back out of the link; it rejoins the following text run.
    const href = m[0].replace(TRAILING, '');
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({ type: 'url', value: href, href });
    last = m.index + href.length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}
