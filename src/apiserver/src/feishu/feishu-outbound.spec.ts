import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FeishuOutbound, rateLimitWaitMs } from './feishu-outbound';
import { feishuTiming } from './feishu-timing';
import { FakeOpenPlatform } from './test-support/fake-open-platform';

// The outbound client (feishu-outbound.ts) against the fake open platform: send, reply (in a thread or not) and update a
// card as the app, with its tenant_access_token; a 429 waits what Feishu suggests and tries again; Feishu's refusals come
// back with its code and message.

const APP = { platform: 'FEISHU' as const, appId: 'cli_0123456789abcdef', appSecret: 'outbound-secret' };

test('the outbound client sends, replies and updates cards, and waits out a 429 as Feishu suggests', async (t) => {
  const fake = new FakeOpenPlatform();
  fake.addApp({ ...APP, appId: APP.appId });
  const before = process.env[FEISHU_TEST_OPEN_PLATFORM_ENV];
  process.env[FEISHU_TEST_OPEN_PLATFORM_ENV] = await fake.start();
  t.after(async () => {
    if (before === undefined) delete process.env[FEISHU_TEST_OPEN_PLATFORM_ENV]; else process.env[FEISHU_TEST_OPEN_PLATFORM_ENV] = before;
    await fake.stop();
  });
  const outbound = new FeishuOutbound();
  const waited: number[] = [];
  outbound.wait = async (ms) => void waited.push(ms);

  await t.test('send, reply in a thread, update a card', async () => {
    const sent = await outbound.send(APP, { receiveIdType: 'open_id', receiveId: 'ou_owner' }, { msgType: 'text', content: { text: 'Hello' } });
    assert.equal(sent.ok, true);
    const replied = await outbound.reply(APP, 'om_root', { msgType: 'text', content: { text: 'Done' } }, { replyInThread: true });
    assert.equal(replied.ok, true);
    const updated = await outbound.updateCard(APP, 'om_card', { elements: [] });
    assert.equal(updated.ok, true);
    const [send, reply, patch] = fake.messages;
    assert.equal(send.method, 'POST');
    assert.equal(send.path, '/open-apis/im/v1/messages');
    assert.equal(send.query.get('receive_id_type'), 'open_id');
    assert.deepEqual(send.body, { receive_id: 'ou_owner', msg_type: 'text', content: '{"text":"Hello"}' });
    assert.equal(reply.path, '/open-apis/im/v1/messages/om_root/reply');
    assert.deepEqual(reply.body, { msg_type: 'text', content: '{"text":"Done"}', reply_in_thread: true });
    assert.equal(patch.method, 'PATCH');
    assert.equal(patch.path, '/open-apis/im/v1/messages/om_card');
    assert.deepEqual(patch.body, { content: '{"elements":[]}' });
    for (const r of fake.messages) assert.ok(fake.tenantAccessTokens.includes(String(r.headers.authorization).replace('Bearer ', '')));
  });

  await t.test('a 429 waits the suggested time, twice, then succeeds', async () => {
    let limited = 2;
    fake.route('POST', '/open-apis/im/v1/messages', () => {
      if (limited-- > 0) return { status: 429, body: { code: 99991400, msg: 'request trigger frequency limit' }, headers: { 'x-ogw-ratelimit-reset': '3' } };
      return { status: 200, body: { code: 0, msg: 'success', data: { message_id: 'om_after' } } };
    });
    waited.length = 0;
    const sent = await outbound.send(APP, { receiveIdType: 'chat_id', receiveId: 'oc_1' }, { msgType: 'text', content: { text: 'x' } });
    assert.deepEqual(sent, { ok: true, messageId: 'om_after' });
    assert.deepEqual(waited, [3000, 3000]);
  });

  await t.test('a 429 that does not clear is answered as Feishu worded it, after three waits', async () => {
    fake.route('POST', '/open-apis/im/v1/messages', () => ({ status: 429, body: { code: 99991400, msg: 'request trigger frequency limit' } }));
    waited.length = 0;
    const sent = await outbound.send(APP, { receiveIdType: 'chat_id', receiveId: 'oc_1' }, { msgType: 'text', content: { text: 'x' } });
    assert.deepEqual(sent, { ok: false, status: 429, feishuCode: 99991400, feishuMsg: 'request trigger frequency limit' });
    assert.deepEqual(waited, [1000, 1000, 1000]);
  });

  await t.test("a refusal carries Feishu's code and message", async () => {
    fake.route('POST', '/open-apis/im/v1/messages/:message_id/reply', () => ({ status: 400, body: { code: 230011, msg: 'The message was withdrawn.' } }));
    const replied = await outbound.reply(APP, 'om_gone', { msgType: 'text', content: { text: 'x' } });
    assert.deepEqual(replied, { ok: false, status: 400, feishuCode: 230011, feishuMsg: 'The message was withdrawn.' });
  });
});

test("a 429's wait: Feishu's reset header, retry-after, or the default", () => {
  const timing = feishuTiming();
  assert.equal(rateLimitWaitMs({ 'x-ogw-ratelimit-reset': '2' }, timing), 2000);
  assert.equal(rateLimitWaitMs({ 'retry-after': '5' }, timing), 5000);
  assert.equal(rateLimitWaitMs({}, timing), timing.rateLimitDefaultMs);
  assert.equal(rateLimitWaitMs(undefined, timing), timing.rateLimitDefaultMs);
});
