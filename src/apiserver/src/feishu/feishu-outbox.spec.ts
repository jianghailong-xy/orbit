import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEISHU_CARD_MAX_BYTES } from './cards/feishu-cards';
import { FEISHU_TEXT_MAX_BYTES, REPLY_CUT_NOTE, renderSessionReply } from './cards/feishu-reply-cards';
import { FEISHU_OUTBOX_MAX_ATTEMPTS, outboxRetryMs } from './feishu-outbox';
import { registerFeishuReply } from './feishu-outbox-register';
import { feishuTiming } from './feishu-timing';

// The pieces of a session's reply going back to Feishu that need no database (docs/feishu-bot-design.md §7.5, task
// F2-4): how the words are drawn — a card's markdown within 30 KB, plain text within 150 KB, cut past that — and how
// long a failed reply waits. The outbox itself, with turn-complete and a failing Feishu, is feishu-outbox.pg.spec.ts.

const URL = 'https://orbit.example/sessions/abc';
const bytes = (content: unknown) => Buffer.byteLength(JSON.stringify(content), 'utf8');
type Card = { body: { elements: Array<Record<string, any>> }; config: { summary: { content: string } } };

test('a reply within 30 KB is a card: the words as markdown, and Open in Orbit only in a direct chat', () => {
  const words = '**Done.** The export bug is fixed.\n\n- `src/export.ts`: the header row';
  const direct = renderSessionReply(words, URL);
  assert.equal(direct.msgType, 'interactive');
  const card = direct.content as Card;
  assert.deepEqual(card.body.elements[0], { tag: 'markdown', content: words }, 'the agent\'s words as they are');
  const button = card.body.elements[1]!;
  assert.equal(button.text.content, 'Open in Orbit');
  assert.equal(button.behaviors[0].default_url, URL);
  assert.equal(card.config.summary.content, '**Done.** The export bug is fixed.');

  const group = renderSessionReply(words, null);
  assert.deepEqual((group.content as Card).body.elements, [{ tag: 'markdown', content: words }], 'in a group, the words alone');
  assert.ok(!JSON.stringify(group.content).includes('orbit.example'));
});

test('past 30 KB the reply is plain text; past 150 KB it is cut, and says so', () => {
  const long = 'a'.repeat(FEISHU_CARD_MAX_BYTES);
  const plain = renderSessionReply(long, URL);
  assert.equal(plain.msgType, 'text');
  assert.deepEqual(plain.content, { text: `${long}\n\nOpen in Orbit: ${URL}` });
  assert.deepEqual(renderSessionReply(long, null).content, { text: long }, 'no link in a group');

  // Three bytes a code point, and a JSON escape for each newline: the cut is measured as Feishu receives it.
  const huge = '修复\n'.repeat(FEISHU_TEXT_MAX_BYTES / 4);
  const cut = renderSessionReply(huge, null);
  assert.equal(cut.msgType, 'text');
  const text = (cut.content as { text: string }).text;
  assert.ok(bytes(cut.content) <= FEISHU_TEXT_MAX_BYTES, 'within 150 KB');
  assert.ok(bytes(cut.content) > FEISHU_TEXT_MAX_BYTES - 64, 'and as much of the words as fits');
  assert.ok(text.endsWith(`\n\n${REPLY_CUT_NOTE}`));
  assert.ok(huge.startsWith(text.slice(0, -REPLY_CUT_NOTE.length - 2)), 'the head of the words, never a split character');
  const cutDirect = renderSessionReply(huge, URL);
  assert.ok((cutDirect.content as { text: string }).text.endsWith(`${REPLY_CUT_NOTE}\n\nOpen in Orbit: ${URL}`));
  assert.ok(bytes(cutDirect.content) <= FEISHU_TEXT_MAX_BYTES);
});

test('a failed reply waits 5 s, doubling, at most 10 minutes, a bounded number of times', () => {
  const timing = feishuTiming();
  assert.deepEqual([1, 2, 3, 4].map((n) => outboxRetryMs(n, timing)), [5_000, 10_000, 20_000, 40_000]);
  assert.equal(outboxRetryMs(FEISHU_OUTBOX_MAX_ATTEMPTS, timing), 10 * 60_000);
  assert.ok(FEISHU_OUTBOX_MAX_ATTEMPTS > 1 && FEISHU_OUTBOX_MAX_ATTEMPTS <= 20);
});

test('registering a reply never throws: a database failure is logged, and turn-complete answers as it would have', async () => {
  const warned: string[] = [];
  await registerFeishuReply(
    { $executeRaw: (() => Promise.reject(new Error('value too long for type'))) as never },
    { warn: (line: string) => warned.push(line) },
    { sessionId: 's', ownerId: 'o', turnId: 't' },
  );
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /^turn t of session s: its Feishu reply was not registered: value too long/);
});
