// Markdown source degraded to the line a reader would see — for the places that show a snippet of
// a field that is rendered as Markdown somewhere else. A project's goal and a task's acceptance
// criteria are written as prompts (headings, bullets, fenced commands, `paths/like/this.ts:521`)
// and read as Markdown on their own page; a list row that shows the same field verbatim shows
// `## 现状缺口` and `**一个依赖字段都没有**` as source, which is what this removes.
//
// Deliberately not a Markdown parser. Pulling remark in to serialize an AST back to text would
// cost more than the whole page for a one-line row, and the failure mode here is cosmetic: an
// exotic construct that survives is a stray character in a snippet, not a broken render. What
// matters is that the marks anyone actually writes are gone and the words survive in order.

/** Inline code: a span closes on a run of backticks as long as the one that opened it. */
export const INLINE_CODE = /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

/** Keeps code out of the rules that read marks. `hold` leaves a token that no rule matches in its
 *  place and `putBack` swaps the code in again, so a star or a bracket in it stays what it is. */
export function codeHolder() {
  const code: string[] = [];
  return {
    hold: (text: string): string => `\u{E000}${code.push(text) - 1}\u{E000}`,
    putBack: (text: string): string =>
      text.replace(/\u{E000}(\d+)\u{E000}/gu, (_, i: string) => code[Number(i)] ?? ''),
  };
}

/** Emphasis marks off, and only those Markdown would draw as marks: the `_` and `*` of
 *  `tea_user_*_cnch` and the `*` of `2 * 3 * 4` are words someone wrote. \p{L}\p{N} rather than \w
 *  because the boundary has to hold for CJK as well as ASCII. */
export const withoutEmphasis = (text: string): string =>
  text
    // Underscores before stars: whether a `_` is a mark depends on what stands beside it as written.
    .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=[^\s_])(.*?[^\s_])\1(?![\p{L}\p{N}_])/gu, '$2') // _em_, never snake_case
    .replace(/(\*{2,3})(?=[^\s*])(.*?[^\s*])\1/g, '$2') // **bold**, ***both***
    .replace(/\*(?=[^\s*])(.*?[^\s*])\*/g, '$1') // *italic*
    .replace(/~~(?=[^\s~])(.*?[^\s~])~~/g, '$1'); // ~~struck~~

/** `markdown` reduced to a single line of plain text: marks removed, all whitespace — newlines
 *  included — collapsed to single spaces. Returns '' for null/undefined/blank input, so a caller
 *  can spell its own fallback with `|| 'No goal set'`. */
export function markdownToPlainText(markdown: string | null | undefined): string {
  if (!markdown) return '';

  // Every run of whitespace — the blank line between two paragraphs included — becomes the one
  // space that separates them on a single line.
  return withoutMarks(markdown, false).replace(/\s+/g, ' ').trim();
}

/** `markdown` as plain text that keeps its lines: the same marks removed, but each paragraph and
 *  list item stays on a line of its own — a bullet drawn as `•`, an ordered item keeping its
 *  number — with at most one blank line between them. For a box that shows the whole field rather
 *  than a snippet of it: a report written as a lead and a list, flattened onto one line, is a
 *  run-on sentence that has lost the list. Shown with `white-space: pre-wrap`. Returns '' for
 *  null/undefined/blank input. */
export function markdownToPlainLines(markdown: string | null | undefined): string {
  if (!markdown) return '';

  return (
    withoutMarks(markdown.replace(/\r\n?/g, '\n'), true)
      // Trailing whitespace goes, and so does a stack of blank lines — most of them the rows a
      // fence or a thematic break used to take up.
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** The marks taken off, line by line, with every line left where it was. `keepLines` is only
 *  about the list markers: a single line has no use for them, kept lines do. */
function withoutMarks(markdown: string, keepLines: boolean): string {
  const { hold, putBack } = codeHolder();
  const blocks = markdown
    // Fence lines go. The code between them is text a reader would still recognise — a row whose
    // goal is mostly a command should show the command, not an empty string — so it is held, as
    // inline code is, out of every rule below.
    .replace(/^[ \t]*(`{3,}|~{3,})[^`\n]*\n?([\s\S]*?)\r?\n?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm, (_, _fence: string, code: string) => hold(code))
    .replace(INLINE_CODE, (_, _ticks: string, code: string) => hold(code))
    // Thematic breaks before the list rule below, which would otherwise read `- - -` as a
    // bullet; setext underlines before it too, for the `---` spelling they share.
    .replace(/^[ \t]*(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, '')
    .replace(/^[ \t]*=+[ \t]*$/gm, '')
    // ATX headings: the opening run, and the optional closing one that mirrors it.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/[ \t]+#+[ \t]*$/gm, '')
    // Blockquote markers, however deeply nested (`> > quoted`).
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, '');

  return putBack(
    withoutEmphasis(
      (keepLines
        // A bullet keeps its place as `•` at its own indent, so a nested item still reads as one;
        // an ordered item keeps its number, which is text a reader counts by.
        ? blocks.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
        // List markers, bulleted and ordered alike, at any indent.
        : blocks.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, ''))
        // Images before links: `![alt](src)` is a link whose text is its alt, and taking the link
        // syntax first would leave the `!` behind with nothing attached to it.
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Reference links (`[text][ref]`, `[text][]`) keep their text the same way.
        .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
        // An autolink reads as the URL it points at.
        .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1'),
    ),
  );
}
