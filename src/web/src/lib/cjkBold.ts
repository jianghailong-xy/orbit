// Bold that CommonMark leaves drawn with its stars. A closing `**` with punctuation on its inside
// closes only if whitespace or punctuation stands on its outside, and an opening one mirrors that:
// a rule written for languages that put a space after a colon, so `**做法：**照上个` and
// `这是**“重点”**内容` reach the reader as they were typed, on every parser the clients use.
//
// Moving one punctuation mark across the `**` makes it flank and draws the same words: the bold just
// stops a mark short. The source changes and the parser stays as it is, so the three clients read
// one rule (OrbitKit `mendCjkBold`, Android `mendCjkBold`). Only where CJK stands at the marks, the
// one place this rule misfires, and never in code.

const FENCE = /^[ \t>]*(`{3,}|~{3,})(.*?)\r?$/;
const CODE_SPAN = /(?<!`)(`+)(?!`).*?[^`]\1(?!`)/g;
// What a mark must not be moved out of, held with the code: a link's or an image's `)`, a reference
// link's `]`, a tag's `>`, an entity's `;` and the mark an escape is for.
const WHOLE = /!?\[[^\]\n]*\]\([^)\n]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]|<[A-Za-z/!?][^>\n]*>|&#?[A-Za-z0-9]+;|\\[!-/:-@[-`{-~]/g;
// A pair read left to right, so a closing `**` is never taken for the next pair's opening one.
const BOLD = /(?<!\*)\*\*(?![\s*])((?:[^*]|\*(?!\*))+?)(?<!\s)\*\*(?!\*)/g;
const FIRST = /^\P{M}\p{M}*/u;
const LAST = /\P{M}\p{M}*$/u;
// What a bold phrase opens or ends on in a sentence. Never `/`, `.` or `-`, which stand beside `**`
// in what is not bold at all: `src/tasks/**和 lib/**目录` are paths and `值**-1` is a power.
const SENTENCE_MARK = /^(?:[:;,!?()"'%+#$]|(?![\x00-\x7F])[\p{P}\p{S}])\p{M}*$/u;
// Not whitespace, punctuation or held code. A symbol counts as a word here because cmark-gfm, the
// parser behind OrbitKit, reads it as one, and the mark moved in front of it flanks for all of them.
const WORD = /^[^\s\p{P}\u{E000}]/u;
const CJK = /[\u{2E80}-\u{9FFF}\u{AC00}-\u{D7AF}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FFEF}\u{20000}-\u{3FFFF}]/u;

const misflanks = (inside: string, outside: string): boolean =>
  SENTENCE_MARK.test(inside) && WORD.test(outside) && (CJK.test(inside) || CJK.test(outside));

function mendLine(line: string): string {
  const code: string[] = [];
  const hold = (span: string) => `\u{E000}${code.push(span) - 1}\u{E000}`;
  const held = line.replace(CODE_SPAN, hold).replace(WHOLE, hold);
  const mended = held.replace(BOLD, (pair: string, inner: string, at: number) => {
    const first = FIRST.exec(inner)?.[0] ?? '';
    const last = LAST.exec(inner)?.[0] ?? '';
    const moveFirst = misflanks(first, LAST.exec(held.slice(0, at))?.[0] ?? '');
    const moveLast = misflanks(last, FIRST.exec(held.slice(at + pair.length))?.[0] ?? '');
    const middle = inner.slice(moveFirst ? first.length : 0, moveLast ? inner.length - last.length : inner.length);
    // Nothing left to be bold, or a space now where a mark stood: these marks would not flank either.
    if (!middle || /^\s|\s$/.test(middle)) return pair;
    return `${moveFirst ? first : ''}**${middle}**${moveLast ? last : ''}`;
  });
  // Last held first: a link can hold a code span that was held before it.
  return code.reduceRight((text, span, i) => text.replace(`\u{E000}${i}\u{E000}`, () => span), mended);
}

export function mendCjkBold(markdown: string): string {
  if (!markdown.includes('**')) return markdown;
  let fence = '';
  return markdown
    .split('\n')
    .map((line) => {
      const mark = FENCE.exec(line);
      if (fence) {
        if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = '';
        return line;
      }
      if (mark && !(mark[1][0] === '`' && mark[2].includes('`'))) {
        fence = mark[1];
        return line;
      }
      return line.includes('**') ? mendLine(line) : line;
    })
    .join('\n');
}
