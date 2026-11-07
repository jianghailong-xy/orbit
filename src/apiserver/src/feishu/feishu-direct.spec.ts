import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_WORKSPACE_ACTION, renderStatusCard, renderWorkspaceChosenCard, renderWorkspacePickerCard } from './cards/feishu-direct-cards';
import { isOrbitAuthoredTurn } from '../sessions/orbit-authored-turn';
import { FEISHU_DIRECT_REPLIES, directCommandOf, directMessageOf, feishuDerivedUuid, feishuTurnKey } from './feishu-direct.service';

// The pieces of the owner's direct messages that need no database (docs/feishu-bot-design.md §7.3, task F2-3): how a
// message is read, which words are commands, the ids derived from an event, and the cards. The routing itself, with
// sessions and turns, is feishu-direct.pg.spec.ts.

const event = (message: Record<string, unknown>) => ({ event: { message: { message_id: 'om_1', chat_id: 'oc_1', ...message } } });

test('a direct message is read as text or as not text, and as a reply when it carries root_id / parent_id', () => {
  assert.deepEqual(directMessageOf(event({ message_type: 'text', content: '{"text":"  fix the build "}' })),
    { messageId: 'om_1', chatId: 'oc_1', rootId: undefined, parentId: undefined, text: 'fix the build' });
  assert.deepEqual(directMessageOf(event({ message_type: 'text', content: '{"text":"yes"}', root_id: 'om_root', parent_id: 'om_parent' })),
    { messageId: 'om_1', chatId: 'oc_1', rootId: 'om_root', parentId: 'om_parent', text: 'yes' });
  for (const other of [
    { message_type: 'image', content: '{"image_key":"img"}' },
    { message_type: 'file', content: '{"file_key":"f"}' },
    { message_type: 'post', content: '{"title":"t"}' },
    { message_type: 'text', content: 'not json' },
    { message_type: 'text', content: '{"text":"   "}' },
  ]) assert.equal(directMessageOf(event(other))?.text, null, JSON.stringify(other));
  assert.equal(directMessageOf({ event: { message: { message_id: 'om_1' } } }), null, 'no chat, nothing to answer in');
  assert.equal(FEISHU_DIRECT_REPLIES.nonText, 'Only text messages are supported for now.');
});

test('help and status are commands only as the whole message', () => {
  assert.equal(directCommandOf(' Help '), 'help');
  assert.equal(directCommandOf('STATUS'), 'status');
  for (const words of ['help me fix the build', 'what is the status', 'disconnect', '']) assert.equal(directCommandOf(words), null, words);
});

test('ids derived from an event are UUIDs, the same for the same reasons and different for others', () => {
  const a = feishuDerivedUuid('feishu-turn', 'cli_a', 'ev-1');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(feishuDerivedUuid('feishu-turn', 'cli_a', 'ev-1'), a);
  assert.notEqual(feishuDerivedUuid('feishu-turn', 'cli_a', 'ev-2'), a);
  assert.notEqual(feishuDerivedUuid('feishu-turn', 'cli_b', 'ev-1'), a);
  assert.notEqual(feishuDerivedUuid('feishu-session', 'cli_a', 'ev-1'), a);
});

test('the receipt reads Started · <title> · <workspace>', () => {
  assert.equal(FEISHU_DIRECT_REPLIES.started('Fix the build', 'orbit'), 'Started · Fix the build · orbit');
});

test('the workspace picker offers a button per workspace whose click names it; once chosen, no buttons', () => {
  const card = renderWorkspacePickerCard([{ id: 'w-1', name: 'orbit' }, { id: 'w-2', name: 'docs' }]);
  const buttons = card.body.elements.filter((e) => e.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.text.content), ['orbit', 'docs']);
  assert.deepEqual(buttons.map((b) => b.behaviors[0].value), [
    { kind: DEFAULT_WORKSPACE_ACTION, workspaceId: 'w-1' },
    { kind: DEFAULT_WORKSPACE_ACTION, workspaceId: 'w-2' },
  ]);
  const chosen = JSON.stringify(renderWorkspaceChosenCard('orbit'));
  assert.ok(!chosen.includes('"button"'));
  assert.ok(chosen.includes('orbit'));
});

test('status lists each waiting session with its owner items and Open in Orbit; nothing waiting says so', () => {
  const card = renderStatusCard([
    { title: 'Fix the build', ownerItems: [], url: 'https://orbit.example/sessions/a' },
    { title: 'Feishu project', ownerItems: ['Approve merge to main'], url: 'https://orbit.example/sessions/b' },
  ]);
  assert.equal(card.header.title.content, 'Waiting on you · 2');
  const texts = card.body.elements.filter((e) => e.tag === 'div').map((e) => e.text.content);
  assert.deepEqual(texts, ['Fix the build', 'Feishu project', '• Approve merge to main']);
  const opens = card.body.elements.filter((e) => e.tag === 'button');
  assert.deepEqual(opens.map((b) => [b.text.content, b.behaviors[0].default_url]), [
    ['Open in Orbit', 'https://orbit.example/sessions/a'],
    ['Open in Orbit', 'https://orbit.example/sessions/b'],
  ]);
  const empty = renderStatusCard([]);
  assert.equal(empty.header.title.content, 'Nothing is waiting on you');
  assert.ok(!JSON.stringify(empty).includes('"button"'));
});

test('a Feishu turn\'s key is the same for the same event, and never reads as a turn Orbit wrote itself', () => {
  const key = feishuTurnKey('cli_a', 'ev-1');
  assert.equal(key, feishuTurnKey('cli_a', 'ev-1'));
  assert.notEqual(feishuTurnKey('cli_a', 'ev-2'), key);
  assert.notEqual(feishuTurnKey('cli_b', 'ev-1'), key);
  // A bare derived UUID is the platform's own key; a Feishu turn is a person's words.
  assert.equal(isOrbitAuthoredTurn(feishuDerivedUuid('feishu-turn', 'cli_a', 'ev-1')), true);
  assert.equal(isOrbitAuthoredTurn(key), false);
});
