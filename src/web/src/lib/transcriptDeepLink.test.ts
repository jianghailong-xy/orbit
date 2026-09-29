// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { encodeId } from './idCodec';
import {
  elementForSeq,
  RECORD_PARAM,
  recordAtOf,
  recordScrollDelta,
  sessionCardHref,
  sessionRecordHref,
} from './transcriptDeepLink';

const SESSION = '01a0d191-1a54-76ee-b10c-df98bbadec34';
const RECORD = '01a0d191-2b10-7a00-8a00-000000000abc';

describe('a link to one record of a session', () => {
  it('is the session page with the record in `at`, both ids in their public spelling', () => {
    const href = sessionRecordHref(SESSION, RECORD);
    expect(href).toBe(`/sessions/${encodeId(SESSION)}?at=${encodeId(RECORD)}`);
    expect(RECORD_PARAM).toBe('at');
    // Either spelling in, one link out: the two spellings of an id are one record.
    expect(sessionRecordHref(encodeId(SESSION), encodeId(RECORD))).toBe(href);
  });

  it('reads the record back from the query in either spelling, and nothing that is not an id', () => {
    expect(recordAtOf(new URLSearchParams(`at=${encodeId(RECORD)}`))).toBe(encodeId(RECORD));
    expect(recordAtOf(new URLSearchParams(`at=${RECORD}`))).toBe(encodeId(RECORD));
    expect(recordAtOf(new URLSearchParams(`x=1&at=%20${encodeId(RECORD)}%20`))).toBe(encodeId(RECORD));
    // A session link without a record, or with a malformed one, opens at the latest message.
    expect(recordAtOf(new URLSearchParams(''))).toBeNull();
    expect(recordAtOf(new URLSearchParams('at='))).toBeNull();
    expect(recordAtOf(new URLSearchParams('at=not-an-id!'))).toBeNull();
  });
});

describe('a pasted session URL that names a record', () => {
  it('keeps the record on the card that stands for it', () => {
    const page = `/sessions/${encodeId(SESSION)}`;
    expect(sessionCardHref(page, `https://orbitd.io${page}?at=${RECORD}`)).toBe(`${page}?at=${encodeId(RECORD)}`);
    // No record, or not an id: the card leads to the session as it always has.
    expect(sessionCardHref(page, `https://orbitd.io${page}`)).toBe(page);
    expect(sessionCardHref(page, `https://orbitd.io${page}?at=nope!`)).toBe(page);
  });
});

describe('where the record is on screen', () => {
  const transcript = (): HTMLElement => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="chat-user" data-seq="10">the question</div>
      <div class="chat-tool-card" data-seq="12"><div class="chat-tool-body">folded result</div></div>
      <div class="chat-msg" data-seq="15">the answer</div>`;
    return root;
  };

  it('is the row a seq starts at, or the card an event folded into', () => {
    const root = transcript();
    expect(elementForSeq(root, 10)?.textContent).toBe('the question');
    // seq 13 is the tool_result drawn inside the card its tool_use (12) starts.
    expect(elementForSeq(root, 13)?.getAttribute('data-seq')).toBe('12');
    expect(elementForSeq(root, 99)?.getAttribute('data-seq')).toBe('15');
    expect(elementForSeq(root, 3)).toBeNull();
  });

  it('is scrolled to the middle of the view when it fits, and to just under its top when it does not', () => {
    const view = { top: 100, height: 800 };
    // A 200px row whose top is 1,000px down the content lands centred: 300px above and below it.
    expect(recordScrollDelta(view, { top: 1100, height: 200 })).toBe(1100 - 100 - 300);
    // A reply taller than the view is read from its start: its top lands 96px under the view's.
    expect(recordScrollDelta(view, { top: 1100, height: 2000 })).toBe(1100 - 100 - 96);
  });
});
