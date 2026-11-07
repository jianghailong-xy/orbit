import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventIdentity } from './feishu-inbox.service';
import { FEISHU_OWNER_REPLIES, codeIn, generateConnectCode, hashConnectCode } from './feishu-owner.service';
import { FeishuRouter, classify, textMessageOf } from './feishu-router';
import { backoffMs, feishuTiming } from './feishu-timing';
import { decodeFrame, encodeFrame } from './test-support/fake-frames';

// The pieces of F0-2 that need no database: which branch an event goes to and who it acts as (feishu-router.ts), the
// inbox's reading of an envelope's identity (feishu-inbox.service.ts), the connection's backoff (feishu-timing.ts),
// and the fake open platform's frame codec, which the pg spec relies on.

const message = (chatType: string) => ({
  schema: '2.0',
  header: { event_id: 'ev-1', event_type: 'im.message.receive_v1', app_id: 'cli_a' },
  event: {
    sender: { sender_id: { open_id: 'ou_sender' } },
    message: { message_id: 'om_1', chat_type: chatType, message_type: 'text', content: '{"text":"secret words"}' },
  },
});

test('each event type goes to its branch, with who acted and the message it names', () => {
  assert.deepEqual(classify('im.message.receive_v1', message('p2p')), { route: 'DIRECT_MESSAGE', openId: 'ou_sender', messageId: 'om_1' });
  assert.deepEqual(classify('im.message.receive_v1', message('group')), { route: 'GROUP_MENTION', openId: 'ou_sender', messageId: 'om_1' });
  assert.deepEqual(
    classify('card.action.trigger', { event: { operator: { open_id: 'ou_clicker' }, context: { open_message_id: 'om_card' } } }),
    { route: 'CARD_ACTION', openId: 'ou_clicker', messageId: 'om_card' },
  );
  assert.deepEqual(
    classify('im.chat.member.bot.deleted_v1', { event: { chat_id: 'oc_1', operator_id: { open_id: 'ou_admin' } } }),
    { route: 'BOT_REMOVED_FROM_CHAT', openId: 'ou_admin' },
  );
  assert.equal(classify('im.message.reaction.created_v1', {}).route, 'IGNORED');
  assert.equal(classify('im.message.receive_v1', { event: 'not an object' }).route, 'IGNORED');
});

test("the router acts as the account the app belongs to, with a FEISHU credential, and logs no message text", async () => {
  const prisma = { feishuApp: { findUnique: async ({ where }: { where: { appId: string } }) => (where.appId === 'cli_a' ? { ownerId: 'user-a' } : null) } };
  const handed: unknown[] = [];
  const owner = {
    handleMessage: async (_app: unknown, m: unknown) => { handed.push(m); return false; },
    replyTo: async () => null,
  };
  const direct = { handleMessage: async () => undefined, handleCardAction: async () => null };
  const router = new FeishuRouter(prisma as never, owner as never, direct as never);
  const logged: string[] = [];
  (router as unknown as { logger: { log: (m: string) => void } }).logger = { log: (m) => logged.push(m) };
  const decision = await router.route({ appId: 'cli_a', eventId: 'ev-1', eventType: 'im.message.receive_v1', payload: message('p2p') });
  assert.deepEqual(decision, {
    route: 'DIRECT_MESSAGE',
    actor: { userId: 'user-a', credential: { kind: 'FEISHU', appId: 'cli_a', openId: 'ou_sender', messageId: 'om_1' } },
  });
  assert.equal(await router.route({ appId: 'cli_gone', eventId: 'ev-2', eventType: 'im.message.receive_v1', payload: message('p2p') }), null);
  assert.ok(logged.length === 3 && logged.every((line) => !line.includes('secret words')));
  assert.deepEqual(handed, [{ chatType: 'p2p', openId: 'ou_sender', messageId: 'om_1', text: 'secret words' }], 'a text message is offered to the owner branch');
});

test('only the owner is served: a stranger\'s direct message gets one sentence, a stranger\'s card click a toast', async () => {
  let ownerOpenId: string | null = null;
  const prisma = { feishuApp: { findUnique: async () => ({ ownerId: 'user-a', appId: 'cli_a', ownerOpenId }) } };
  const replies: Array<[string, string]> = [];
  let code = false;
  const owner = {
    handleMessage: async () => code,
    replyTo: async (_app: unknown, messageId: string, words: string) => { replies.push([messageId, words]); return null; },
  };
  const directed: string[] = [];
  const direct = {
    handleMessage: async (_app: unknown, actor: { credential: { openId: string } }) => { directed.push(actor.credential.openId); },
    handleCardAction: async () => null,
  };
  const router = new FeishuRouter(prisma as never, owner as never, direct as never);
  (router as unknown as { logger: { log: () => void } }).logger = { log: () => undefined };
  const dm = (payload: unknown = message('p2p')) => router.route({ appId: 'cli_a', eventId: 'ev', eventType: 'im.message.receive_v1', payload });
  const click = (openId: string) => router.route({
    appId: 'cli_a', eventId: 'ev', eventType: 'card.action.trigger',
    payload: { event: { operator: { open_id: openId }, context: { open_message_id: 'om_card' } } },
  });
  const toast = { toast: { type: 'error', content: 'Only the owner of this bot can answer this card.' } };

  // Nobody is the owner yet: how to become it; a click by anyone is refused.
  await dm();
  assert.deepEqual(replies.splice(0), [['om_1', FEISHU_OWNER_REPLIES.noOwner]]);
  assert.deepEqual((await click('ou_sender'))?.answer, toast);

  ownerOpenId = 'ou_owner';
  await dm();
  const image = message('p2p');
  image.event.message.message_type = 'image';
  await dm(image);
  assert.deepEqual(replies.splice(0), [['om_1', 'This bot only takes direct messages from its owner.'], ['om_1', 'This bot only takes direct messages from its owner.']]);
  assert.deepEqual((await click('ou_sender'))?.answer, toast);
  assert.deepEqual((await click(''))?.answer, toast);
  assert.equal((await click('ou_owner'))?.answer, undefined, "the owner's click passes the check");

  // An owner code is the owner branch's to answer, from anyone; the owner's own message is not refused.
  code = true;
  await dm();
  code = false;
  const own = message('p2p');
  own.event.sender.sender_id.open_id = 'ou_owner';
  await dm(own);
  assert.deepEqual(replies, []);
  // Only the owner's own direct message, not an owner code, reaches the direct-message branch (§7.3).
  assert.deepEqual(directed, ['ou_owner']);
});

test('an owner code: 8 characters of an alphabet without 0/O/1/I, with a digit; typed loosely, read strictly', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateConnectCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.match(code, /[2-9]/);
    assert.equal(codeIn(code), code);
  }
  assert.equal(codeIn(' abcd-2345 '), 'ABCD2345');
  assert.equal(codeIn('ABCD 2345'), 'ABCD2345');
  for (const notACode of ['PASSWORD', 'thankyou', 'ABCD234', 'ABCD23456', 'ABCD0345', 'disconnect', 'hello there', '']) {
    assert.equal(codeIn(notACode), null, notACode);
  }
  assert.match(hashConnectCode('ABCD2345'), /^[0-9a-f]{64}$/);
  assert.equal(FEISHU_OWNER_REPLIES.connected, "You're connected as the owner of this Orbit bot.");
});

test("a text message's text: a direct message as sent, a group's without its @mentions; anything else is none", () => {
  const event = (chatType: string, content: string, messageType = 'text') => ({
    event: {
      sender: { sender_id: { open_id: 'ou_s' } },
      message: { message_id: 'om_x', chat_type: chatType, message_type: messageType, content },
    },
  });
  assert.deepEqual(textMessageOf(event('p2p', '{"text":" ABCD2345 "}')), { chatType: 'p2p', openId: 'ou_s', messageId: 'om_x', text: 'ABCD2345' });
  assert.deepEqual(textMessageOf(event('group', '{"text":"@_user_1 ABCD2345"}')), { chatType: 'group', openId: 'ou_s', messageId: 'om_x', text: 'ABCD2345' });
  assert.equal(textMessageOf(event('p2p', '{"image_key":"img"}', 'image')), null);
  assert.equal(textMessageOf(event('p2p', 'not json')), null);
  assert.equal(textMessageOf(event('topic', '{"text":"x"}')), null);
});

test("an envelope's identity: schema 2.0's header, or a v1 event's uuid; none is no identity", () => {
  assert.deepEqual(eventIdentity(message('p2p')), { eventId: 'ev-1', eventType: 'im.message.receive_v1' });
  assert.deepEqual(eventIdentity({ uuid: 'u-1', event: { type: 'message' } }), { eventId: 'u-1', eventType: 'message' });
  assert.equal(eventIdentity({ header: { event_type: 'x' } }), null);
  assert.equal(eventIdentity(null), null);
});

test('a failed connection backs off from 1 minute, doubling, to at most 1 hour', () => {
  const timing = feishuTiming();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => backoffMs(n, timing) / 60_000), [1, 2, 4, 8, 16, 32, 60, 60, 60]);
});

test('the time scale is ignored in production', () => {
  const before = { env: process.env.NODE_ENV, scale: process.env.ORBIT_TEST_FEISHU_TIME_SCALE };
  try {
    process.env.ORBIT_TEST_FEISHU_TIME_SCALE = '100';
    process.env.NODE_ENV = 'production';
    assert.equal(feishuTiming().backoffBaseMs, 60_000);
    process.env.NODE_ENV = 'test';
    assert.equal(feishuTiming().backoffBaseMs, 600);
    assert.equal(feishuTiming().inboxRetentionMs, 7 * 24 * 60 * 60_000);
  } finally {
    if (before.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before.env;
    if (before.scale === undefined) delete process.env.ORBIT_TEST_FEISHU_TIME_SCALE; else process.env.ORBIT_TEST_FEISHU_TIME_SCALE = before.scale;
  }
});

test("the fake's frames round-trip, the SDK's required fields included", () => {
  const frame = {
    SeqID: 7, LogID: 2 ** 40, service: 1, method: 1,
    headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm-1' }],
    payload: new TextEncoder().encode('{"a":"é"}'),
  };
  assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
  assert.deepEqual(decodeFrame(encodeFrame({ SeqID: 0, LogID: 0, service: 0, method: 0, headers: [] })), { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [] });
});
