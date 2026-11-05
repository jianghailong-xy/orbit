import type { Element, ElementContent, Root } from 'hast';

/**
 * Inline code kept whole in prose, wherever an agent's words are read: a conversation (`rehypeCodeWords`) and a wiki
 * document (`WikiWords`).
 *
 * No line may end before a hyphen and one may after it (UAX 14, LB21). So `、--hour` can only end a line inside `--`, and
 * Chinese prose, which may end a line nearly anywhere else, cuts its flags in two wherever the width falls.
 *
 * Each word of the code stays whole (`.code-word`), and `.code-break` before the code gives back the break the hyphen took
 * away. Both are the stylesheet's, so what a reader copies is the command as written. Two things that look simpler do not
 * work: with <wbr> Safari 26 draws the code's first word twice, at a line's end and at the next one's start; and a line may
 * end at an inline-block's edge, so `、` after the code would open the next line.
 */

/**
 * The longest word kept whole, in characters. At `.md code`'s 12.3px that is about 190px with its padding, and the
 * narrowest line a word is drawn on, a person's bubble on a 320pt phone, has 209px. A longer word wraps as it always did.
 */
export const CODE_WORD_MAX = 24;

const WHOLE_WORD = new RegExp(`^\\S{1,${CODE_WORD_MAX}}$`, 'u');

/** What no line may end with: an opening bracket or quote. */
const OPENS = /[(（[【「『“‘《〈]$/u;

/** A piece of inline code as its words and the spaces between them; `whole` says a word stays on one line. */
export function codeWordParts(code: string): Array<{ text: string; whole: boolean }> {
  return code
    .split(/(\s+)/u)
    .filter((text) => text !== '')
    .map((text) => ({ text, whole: WHOLE_WORD.test(text) }));
}

/** Whether a line may end between these words and the code after them. */
export const breaksBeforeCode = (words: string): boolean => !OPENS.test(words);

/** Whether the node before a piece of inline code needs a `.code-break`: a space ends a line already, and a block's first word has nothing to part from. */
function needsBreak(before: ElementContent | undefined): boolean {
  if (!before) return false;
  if (before.type !== 'text') return true;
  return !/\s$/u.test(before.value) && breaksBeforeCode(before.value);
}

function walk(parent: Root | Element): void {
  const children = parent.children as ElementContent[];
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    // A code block keeps its own lines, and its copy button reads them.
    if (node.type !== 'element' || node.tagName === 'pre') continue;
    if (node.tagName === 'table') {
      // A table's columns are at least as wide as the widest word they hold, so whole words can make it wider than the
      // column. It scrolls on its own then, as a code block does, and not the conversation.
      children[i] = { type: 'element', tagName: 'div', properties: { className: ['md-table-scroll'] }, children: [node] };
    }
    if (node.tagName !== 'code') {
      walk(node);
      continue;
    }
    node.children = node.children.flatMap((child): ElementContent[] =>
      child.type !== 'text'
        ? [child]
        : codeWordParts(child.value).map(({ text, whole }) =>
            whole
              ? { type: 'element', tagName: 'span', properties: { className: ['code-word'] }, children: [{ type: 'text', value: text }] }
              : { type: 'text', value: text },
          ),
    );
    if (needsBreak(children[i - 1])) {
      children.splice(i, 0, { type: 'element', tagName: 'span', properties: { className: ['code-break'] }, children: [] });
      i += 1;
    }
  }
}

/** The rule above for rendered Markdown, as a rehype plugin. */
export function rehypeCodeWords() {
  return (tree: Root): void => walk(tree);
}
