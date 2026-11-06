import { codeHolder, INLINE_CODE, withoutEmphasis } from './markdownText';

// Flatten an assistant reply into a single-line list preview: drop code blocks and the markdown
// marks so the line reads as prose, not syntax, then collapse all whitespace/newlines. Length is
// handled by CSS ellipsis, not here.
//
// Only what Markdown would draw as a mark goes, so the line says what the bubble says: the `_` and
// `*` of `tea_user_*_cnch`, the `~` of `~/.orbit`, the `--` of `--force` and the `#` of `#123` are
// words someone wrote.
//
// A link keeps only its text and an image only its alt, so `[name](orbit-task:…)` reads as `name`.
// Images go first so a linked image, `[![alt](src)](url)`, still comes down to its alt. Inline code
// is held out of every rule and put back at the end, which is what leaves the brackets and marks
// inside `code` alone.
export const plainPreview = (md: string): string => {
  const { hold, putBack } = codeHolder();
  return putBack(
    withoutEmphasis(
      md
        .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
        .replace(INLINE_CODE, (_, _ticks: string, span: string) => hold(span)) // inline code, held out
        .replace(/!\[([^[\]]*)\]\([^)]*\)/g, '$1') // images -> alt
        .replace(/\[([^[\]]*)\]\([^)]*\)/g, '$1') // links -> link text
        .replace(/^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '') // thematic breaks
        .replace(/^(?:[ \t]*(?:>|(?:#{1,6}|[-*])(?=[ \t]|$)))+/gm, ''), // heading / quote / list markers at line start
    ),
  )
    .replace(/\s+/g, ' ')
    .trim();
};
