import { Fragment } from 'react';
import { breaksBeforeCode, codeWordParts } from '../lib/codeWords';
import { wikiProsePunctuation, wikiSentenceSegments } from '../lib/wikiArticles';

/** A sentence's or a heading's words (`wikiSentenceSegments`), its code kept whole by the rule in lib/codeWords. */
export function WikiWords({ text }: { text: string }) {
  return (
    <>
      {wikiSentenceSegments(text).map((segment, i, segments) =>
        segment.kind === 'code' ? (
          <Fragment key={i}>
            {breaksBeforeCode(segments[i - 1]?.text ?? '') && <span className="code-break" />}
            <code>
              {codeWordParts(segment.text).map((part, p) =>
                part.whole ? (
                  <span className="code-word" key={p}>
                    {part.text}
                  </span>
                ) : (
                  part.text
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
