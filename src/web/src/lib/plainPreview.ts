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
  const code: string[] = [];
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    // Inline code, held out: a span closes on a run of backticks as long as the one that opened it.
    .replace(
      /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g,
      (_, _ticks: string, span: string) => `\uE000${code.push(span) - 1}\uE000`,
    )
    .replace(/!\[([^[\]]*)\]\([^)]*\)/g, '$1') // images -> alt
    .replace(/\[([^[\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '') // thematic breaks
    .replace(/^(?:[ \t]*(?:>|(?:#{1,6}|[-*])(?=[ \t]|$)))+/gm, '') // heading / quote / list markers at line start
    // Underscores before stars: whether a `_` is a mark depends on what stands beside it as written.
    .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=[^\s_])(.*?[^\s_])\1(?![\p{L}\p{N}_])/gu, '$2') // _em_, never snake_case
    .replace(/(\*{2,3})(?=[^\s*])(.*?[^\s*])\1/g, '$2') // **bold**, ***both***
    .replace(/\*(?=[^\s*])(.*?[^\s*])\*/g, '$1') // *italic*
    .replace(/~~(?=[^\s~])(.*?[^\s~])~~/g, '$1') // ~~struck~~
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => code[Number(i)] ?? '') // inline code, back without its ticks
    .replace(/\s+/g, ' ')
    .trim();
};
