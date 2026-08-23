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

/** `markdown` reduced to a single line of plain text: marks removed, all whitespace — newlines
 *  included — collapsed to single spaces. Returns '' for null/undefined/blank input, so a caller
 *  can spell its own fallback with `|| 'No goal set'`. */
export function markdownToPlainText(markdown: string | null | undefined): string {
  if (!markdown) return '';

  return (
    markdown
      // Fence lines only. The code between them is text a reader would still recognise — a row
      // whose goal is mostly a command should show the command, not an empty string.
      .replace(/^[ \t]*(?:`{3,}|~{3,}).*$/gm, '')
      // Thematic breaks before the list rule below, which would otherwise read `- - -` as a
      // bullet; setext underlines before it too, for the `---` spelling they share.
      .replace(/^[ \t]*(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, '')
      .replace(/^[ \t]*=+[ \t]*$/gm, '')
      // ATX headings: the opening run, and the optional closing one that mirrors it.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/[ \t]+#+[ \t]*$/gm, '')
      // Blockquote markers, however deeply nested (`> > quoted`).
      .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')
      // List markers, bulleted and ordered alike, at any indent.
      .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '')
      // Images before links: `![alt](src)` is a link whose text is its alt, and taking the link
      // syntax first would leave the `!` behind with nothing attached to it.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Reference links (`[text][ref]`, `[text][]`) keep their text the same way.
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      // An autolink reads as the URL it points at.
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
      // Inline code. The backreference is what makes ``a `b` c`` unwrap once rather than twice:
      // the closing run has to be as long as the opening one.
      .replace(/(`+)([^`]*?)\1/g, '$2')
      // Asterisk emphasis, longest run first so `***x***` does not leave a stray mark. The
      // content must not start or end with whitespace, which is what keeps `2 * 3 * 4` a
      // multiplication rather than an italic ` 3 `.
      .replace(/(\*{1,3})(\S(?:[^*]*\S)?)\1/g, '$2')
      .replace(/~~(\S(?:[^~]*\S)?)~~/g, '$1')
      // Underscore emphasis ONLY where it is not inside a word: `file_path` and `snake_case` are
      // identifiers, and the page that renders this field as Markdown leaves them alone too.
      // \p{L}\p{N} rather than \w because the boundary has to hold for CJK as well as ASCII.
      .replace(/(^|[^\p{L}\p{N}_])(_{1,2})(\S(?:[^_]*\S)?)\2(?![\p{L}\p{N}_])/gu, '$1$3')
      // Whatever backticks are left are an unpaired mark, never punctuation someone meant.
      .replace(/`/g, '')
      // Every run of whitespace — the blank line between two paragraphs included — becomes the
      // one space that separates them on a single line.
      .replace(/\s+/g, ' ')
      .trim()
  );
}
