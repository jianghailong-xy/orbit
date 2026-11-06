// Markdown that reads wrongly because CJK runs straight on from it, with no space between, mended in
// the source before a parser reads it. The parsers stay as they are, so the three clients read one
// rule (OrbitKit `mendCjkMarkdown`, Android `mendCjkMarkdown`). Never in code.
//
// Bold. CommonMark closes a `**` with punctuation on its inside only if whitespace or punctuation
// stands on its outside, and an opening one mirrors that: a rule written for languages that put a
// space after a colon, so `**做法：**照上个` and `这是**“重点”**内容` reach the reader with their stars.
// Moving one punctuation mark across the `**` makes it flank and draws the same words: the bold just
// stops a mark short. Only where CJK stands at the marks, the one place this rule misfires.
//
// A bare URL. GFM takes one up to the next whitespace, so the link in `https://orbitd.io，也就是你的账号`
// runs on through the sentence and opens nowhere. Written as `<https://orbitd.io>` it ends where the
// address does and draws the same words. An address ends at CJK punctuation, and at a CJK letter
// unless that letter opens a path segment, as in `/wiki/中文`.

const FENCE = /^[ \t>]*(`{3,}|~{3,})(.*?)\r?$/;
const CODE_SPAN = /(?<!`)(`+)(?!`).*?[^`]\1(?!`)/g;
// What a mark must not be moved out of, held with the code: a link's or an image's `)`, a reference
// link's `]`, a tag's `>`, an entity's `;` and the mark an escape is for.
const WHOLE = /^[ \t]*\[[^\]\n]*\]:[ \t]*\S+|!?\[[^\]\n]*\]\([^)\n]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]|<[A-Za-z/!?][^>\n]*>|&#?[A-Za-z0-9]+;|\\[!-/:-@[-`{-~]/g;
const BARE_URL = /(?<![A-Za-z])https?:\/\/(?:[!-;=?-~]|(?<=\/)[\u{2E80}-\u{2FFF}\u{3040}-\u{9FFF}\u{AC00}-\u{D7AF}\u{F900}-\u{FAFF}\u{20000}-\u{3FFFF}][^\s<\u{2010}-\u{2027}\u{3000}-\u{303F}\u{FE30}-\u{FE4F}\u{FF00}-\u{FFEF}]*)+/gu;
const ENDS_A_URL = /^[\u{2010}-\u{2027}\u{3000}-\u{303F}\u{FE30}-\u{FE4F}\u{FF00}-\u{FFEF}\u{2E80}-\u{2FFF}\u{3040}-\u{9FFF}\u{AC00}-\u{D7AF}\u{F900}-\u{FAFF}\u{20000}-\u{3FFFF}]/u;
// What GFM leaves off the end of a bare URL as the sentence's, not the address's.
const URL_TAIL = /[?!.,:;*_~'"]+$/;
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

/** The address in `url`: what is left when the sentence's marks and an unmatched `)` come off its end. */
function address(url: string): string {
  let kept = url.replace(URL_TAIL, '');
  while (kept.endsWith(')') && kept.split(')').length > kept.split('(').length) kept = kept.slice(0, -1).replace(URL_TAIL, '');
  return kept;
}

function mendLine(line: string): string {
  const code: string[] = [];
  const hold = (span: string) => `\u{E000}${code.push(span) - 1}\u{E000}`;
  const held = line
    .replace(CODE_SPAN, hold)
    .replace(WHOLE, hold)
    .replace(BARE_URL, (url: string, at: number, text: string) => {
      if (!ENDS_A_URL.test(text.slice(at + url.length))) return url;
      const kept = address(url);
      return kept.endsWith('://') ? url : hold(`<${kept}>`) + url.slice(kept.length);
    });
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

const MIGHT_NEED_MENDING = (text: string): boolean => text.includes('**') || text.includes('://');

export function mendCjkMarkdown(markdown: string): string {
  if (!MIGHT_NEED_MENDING(markdown)) return markdown;
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
      return MIGHT_NEED_MENDING(line) ? mendLine(line) : line;
    })
    .join('\n');
}
