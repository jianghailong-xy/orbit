/**
 * What the server keeps of a text Postgres cannot hold as it is (contract `repoOps.storedText`,
 * `modelQueue.requestEncoding`): a text with a U+0000 in it is kept as its UTF-8 bytes in base64 and read back
 * byte for byte; every other text is kept as it is; a lone surrogate is no text at all. The database half — the
 * rows, the routes — is wiki-repo-op-nul.pg.spec.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { wikiModelRequestCallOf, wikiModelRequestSha256, wikiModelRequestStored } from './wiki-model-queue';
import {
  wikiJsonIsStorable,
  wikiStoredModelText,
  wikiStoredText,
  wikiTextBase64,
  wikiTextFromStored,
  wikiTextIsStorable,
  wikiTextIsWellFormed,
} from './wiki-stored-text';

// Built rather than written: a raw NUL or separator in this source is what the module is about.
const NUL = String.fromCharCode(0);
const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);
const SEPARATOR = String.fromCharCode(0x2028);

/** The incident's line, and the rest of what an encoder or a database treats specially. */
const WITH_NUL = `? check.outputTail.replace(/${NUL}/g, '')\n中文 😀 ${SEPARATOR}\r\n${String.fromCharCode(1)} \\ " <&>`;

test('a text without a NUL is kept as it is and read back as it is — every row the cache held before', () => {
  const text = `中文 😀 ${SEPARATOR}\r\n\\ " <&>`;
  assert.equal(wikiTextIsStorable(text), true);
  assert.deepEqual(wikiStoredText(text), { content: text, encoding: 'text' });
  assert.equal(wikiTextFromStored(text, 'text'), text);
  // A row written before content_encoding existed reads as `text`, whatever the column says of it.
  assert.equal(wikiTextFromStored(text, undefined), text);
});

test('a text with a NUL is kept as its UTF-8 bytes in base64, and read back to the same bytes', () => {
  assert.equal(wikiTextIsStorable(WITH_NUL), false);
  const stored = wikiStoredText(WITH_NUL);
  assert.equal(stored.encoding, 'base64');
  assert.equal(stored.content, Buffer.from(WITH_NUL, 'utf8').toString('base64'));
  assert.equal(stored.content.includes(NUL), false, 'what the row holds has no NUL');
  const back = wikiTextFromStored(stored.content, stored.encoding);
  assert.equal(back, WITH_NUL);
  assert.ok(Buffer.from(back, 'utf8').equals(Buffer.from(WITH_NUL, 'utf8')), 'byte for byte');
  // Only the NUL decides it: one at the very start or end, or nothing but NULs, is kept the same way.
  for (const text of [NUL, `${NUL}a`, `a${NUL}`, NUL.repeat(3)]) {
    const kept = wikiStoredText(text);
    assert.equal(kept.encoding, 'base64');
    assert.equal(wikiTextFromStored(kept.content, kept.encoding), text);
  }
});

test('a lone surrogate is no text: not storable, refused rather than turned into U+FFFD', () => {
  for (const text of [HIGH, LOW, `a${HIGH}b`, `${LOW}${HIGH}`, `${HIGH}${NUL}`]) {
    assert.equal(wikiTextIsWellFormed(text), false, JSON.stringify(text));
    assert.equal(wikiTextIsStorable(text), false);
    assert.throws(() => wikiStoredText(text), /lone surrogate/u);
    assert.throws(() => wikiTextBase64(text), /lone surrogate/u);
  }
  // A whole pair is one character and well formed.
  assert.equal(wikiTextIsWellFormed(`${HIGH}${LOW}`), true);
  assert.equal(wikiTextIsWellFormed('😀'), true);
});

test('a JSON value is storable when every string in it, keys included, is', () => {
  assert.equal(wikiJsonIsStorable({ diff: { files: [{ status: 'M', path: 'src/a.ts' }], docs: [] }, n: 1, ok: true, none: null }), true);
  assert.equal(wikiJsonIsStorable({ diff: { files: [{ status: 'M', path: `src/a${NUL}b.ts` }] } }), false);
  assert.equal(wikiJsonIsStorable({ [`k${NUL}`]: 'v' }), false);
  assert.equal(wikiJsonIsStorable([`x${HIGH}`]), false);
});

test('the model queue keeps a call as it is, or as base64 beside `encoding`, and reads back the call it was', () => {
  const plain = { system: 'system', prompt: 'prompt 中文', maxTokens: 64 };
  assert.deepEqual(wikiModelRequestStored(plain), plain, 'a call Postgres can hold is the column as it always was');
  assert.deepEqual(wikiModelRequestCallOf(wikiModelRequestStored(plain)), plain);

  const carrying = { system: `system ${SEPARATOR}`, prompt: `[C1]\n${WITH_NUL}`, maxTokens: 4096 };
  const stored = wikiModelRequestStored(carrying);
  assert.equal(stored.encoding, 'base64');
  assert.equal(JSON.stringify(stored).includes('\\u0000'), false, 'nothing in the column is a NUL jsonb refuses');
  const back = wikiModelRequestCallOf(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(back, carrying, 'the claim reads back the call the pipeline made');
  // The digest is the call's, so a replay of the same unit still meets its own row.
  assert.equal(wikiModelRequestSha256(back), wikiModelRequestSha256(carrying));
});

test('a model\'s answer is kept as it is, or — with a NUL copied into it — as its bytes, and a split pair is no refusal', () => {
  const answer = `### 本节\n本节依据 C1 写成一句话[C1]。\n\n引文：\n[C1] 「sep := "a${NUL}b"」\n`;
  const kept = wikiStoredModelText(answer);
  assert.equal(kept.encoding, 'base64');
  assert.equal(wikiTextFromStored(kept.content, kept.encoding), answer, 'read back to the text the model sent');
  assert.deepEqual(wikiStoredModelText('中文 😀'), { content: '中文 😀', encoding: 'text' });
  // A partial cut between the two halves of a pair the stream split across deltas: kept as text, as it always was —
  // the driver writes the half as U+FFFD — rather than refused the way a file's text with one is.
  assert.deepEqual(wikiStoredModelText(`a${HIGH}`), { content: `a${HIGH}`, encoding: 'text' });
  assert.equal(wikiStoredModelText(`${NUL}${HIGH}`).encoding, 'base64');
});
