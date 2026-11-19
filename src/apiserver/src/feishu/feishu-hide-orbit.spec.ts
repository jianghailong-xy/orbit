import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECT_GROUP_BODY, CONNECT_GROUP_BUTTON, renderConnectGroupCard } from './cards/feishu-cards';
import { REPLY_CUT_NOTE_GROUP } from './cards/feishu-reply-cards';
import { FEISHU_GROUP_REPLIES } from './feishu-chat-route.service';
import { FEISHU_GROUP_NEUTRAL_REASON, FEISHU_GROUP_WORK_REPLIES, groupReason } from './feishu-group.service';
import { FEISHU_OWNER_REPLIES } from './feishu-owner.service';

// docs/feishu-bot-design.md §15.1: what people other than the owner read — in a group, or in a direct message while the
// bot has no owner — never names Orbit. The bot's own name is the one the owner gave it in Feishu, so it may; the
// sentences are pinned here word for word, then checked with that name taken out.

/** A bot named the way an owner might name it, so a sentence that names nothing else passes only once it is removed. */
const BOT = 'Orbitd';
const withoutBot = (words: string) => words.split(`@${BOT}`).join('@<bot>');

const sentences: Array<[string, string, string]> = [
  ['connect sent', FEISHU_GROUP_REPLIES.connectSent, "I've sent you a link in our direct chat to finish connecting this group."],
  ['not connected', FEISHU_GROUP_REPLIES.notConnected(BOT),
    `This group isn't connected, so nothing was started. The bot's owner can connect it by sending "@${BOT} connect" here.`],
  ['switched off', FEISHU_GROUP_REPLIES.switchedOff,
    "The bot is switched off in this group, so nothing was started. Ask the bot's owner to switch it back on."],
  ['not allowed', FEISHU_GROUP_WORK_REPLIES.notAllowed,
    "This group's connection doesn't take requests from you, so nothing was started. Ask the bot's owner to add you."],
  ['busy', FEISHU_GROUP_WORK_REPLIES.busy(2),
    'Nothing was started: this group already has 2 sessions running, the most its connection allows at a time. Try again when one finishes.'],
  ['daily limit', FEISHU_GROUP_WORK_REPLIES.dailyLimit(1),
    'Nothing was started: this group has started 1 session today, the most its connection allows in a day. Try again after midnight UTC.'],
  ['not started', FEISHU_GROUP_WORK_REPLIES.notStarted('pick a workspace bound to a runner'),
    'Nothing was started: pick a workspace bound to a runner.'],
  ['gone', FEISHU_GROUP_WORK_REPLIES.gone, 'Nothing was started: this group is no longer connected.'],
  ['not sent', FEISHU_GROUP_WORK_REPLIES.notSent('the session has ended'), "This wasn't sent to the session: the session has ended."],
  ['topic not linked', FEISHU_GROUP_WORK_REPLIES.notLinked(BOT),
    `This topic isn't linked to a session. To start one, send "@${BOT} <request>" in the group, not in a topic.`],
  ['external group', FEISHU_GROUP_REPLIES.external,
    'This bot works only in groups inside your organization. This group has members from other organizations.'],
  ['connect by a non-owner', FEISHU_GROUP_REPLIES.strangerConnect, 'Only the owner of this bot can connect this group.'],
  ['group unreadable', FEISHU_GROUP_REPLIES.unreadable,
    "The bot couldn't read this group's information from Feishu. Ask its owner to check the app's im:chat:readonly permission."],
  ['no owner yet', FEISHU_OWNER_REPLIES.noOwner, "This bot isn't set up yet."],
];

for (const [name, actual, expected] of sentences) {
  test(`§15.1 ${name}: the sentence the design prescribes, naming no Orbit but the bot`, () => {
    assert.equal(actual, expected);
    assert.doesNotMatch(withoutBot(actual), /orbit/i);
  });
}

test('§15.1 every other sentence a group reads names no Orbit either', () => {
  const others = [
    FEISHU_GROUP_WORK_REPLIES.empty(BOT),
    FEISHU_GROUP_WORK_REPLIES.started('Fix the build'),
    FEISHU_OWNER_REPLIES.group,
    FEISHU_OWNER_REPLIES.stranger,
    FEISHU_OWNER_REPLIES.strangerCard,
    REPLY_CUT_NOTE_GROUP,
  ];
  for (const words of others) assert.doesNotMatch(withoutBot(words), /orbit/i, words);
});

test('§15.1 a refusal that names Orbit reaches the group as a neutral reason, and one that does not as it is', () => {
  for (const reason of [
    'Antigravity needs Orbit runner 0.1.209 or newer — updates itself when idle',
    'env name "X" is reserved: ORBIT_ variables are set by orbit',
  ]) {
    assert.equal(groupReason(reason), FEISHU_GROUP_NEUTRAL_REASON);
    assert.equal(FEISHU_GROUP_WORK_REPLIES.notStarted(reason), "Nothing was started: the bot's owner needs to look into it.");
    assert.equal(FEISHU_GROUP_WORK_REPLIES.notSent(reason), "This wasn't sent to the session: the bot's owner needs to look into it.");
  }
  assert.equal(groupReason('the session has ended'), 'the session has ended');
});

test('§15.1 the connect card the owner gets in a direct chat: Connect <group>, Choose settings, the ticket link', () => {
  const url = 'https://orbit.example/settings/integrations/feishu/connect-group?ticket=t1';
  const card = renderConnectGroupCard('Platform team', url, 30);
  assert.equal(card.header.title.content, 'Connect Platform team');
  assert.equal(card.config.summary.content, 'Connect Platform team');
  assert.equal(CONNECT_GROUP_BUTTON, 'Choose settings');
  assert.equal(
    CONNECT_GROUP_BODY,
    'Choose the workspace, the permission mode, who in this group can start sessions, and the limits. Nothing runs from this group until you confirm.',
  );
  assert.deepEqual(card.body.elements.slice(0, 2).map((e) => e.text.content), [
    CONNECT_GROUP_BODY,
    'Only you can use this link, once, within 30 minutes.',
  ]);
  const button = card.body.elements[2].columns[0].elements[0];
  assert.deepEqual(button, { tag: 'button', text: { tag: 'plain_text', content: 'Choose settings' }, type: 'primary', behaviors: [{ type: 'open_url', default_url: url }] });
  assert.equal(renderConnectGroupCard(null, url, 30).header.title.content, 'Connect this group');
});
