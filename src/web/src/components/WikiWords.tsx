import { Fragment } from 'react';
import { wikiProsePunctuation, wikiSentenceSegments } from '../lib/wikiArticles';

/** What no line may end with: an opening bracket or quote. */
const OPENS = /[(（[【「『“‘《〈]$/u;

/**
 * A sentence's or a heading's words (`wikiSentenceSegments`). No line may end before a hyphen and one may after it, so
 * `、--hour` can only end a line inside `--`. Each word of the code therefore stays whole (`.wk-code-word`), up to what a
 * 320pt phone's line holds (`.wk-art code`, about 33 characters), and a longer one is left to wrap. `.wk-code-break`
 * before the code gives back the break the hyphen took away. Both are CSS, so what a reader copies is the command as
 * written. Not <wbr>: Safari 26 then draws the code's first word twice, at a line's end and at the next one's start. Not
 * inline-block: a line may end at a box's edge, so `、` after the code would open the next one.
 */
export function WikiWords({ text }: { text: string }) {
  return (
    <>
      {wikiSentenceSegments(text).map((segment, i, segments) =>
        segment.kind === 'code' ? (
          <Fragment key={i}>
            {!OPENS.test(segments[i - 1]?.text ?? '') && <span className="wk-code-break" />}
            <code>
              {segment.text.split(/(\s+)/u).map((part, p) =>
                /^\S{1,32}$/u.test(part) ? (
                  <span className="wk-code-word" key={p}>
                    {part}
                  </span>
                ) : (
                  part
                ),
              )}
            </code>
          </Fragment>
        ) : segment.kind === 'strong' ? (
          <strong key={i}>{wikiProsePunctuation(segment.text)}</strong>
        ) : (
          <Fragment key={i}>{wikiProsePunctuation(segment.text)}</Fragment>
        ),
      )}
    </>
  );
}
