import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { coordinatorDeliveryTurnId } from '../projects/coordinator-delivery.service';
import { criteriaDecisionReplyTurnId } from '../projects/criteria-decision-reply';
import { derivedUuid, isDerivedUuid } from '../projects/project-dispatch-identity';
import { openItemTurnId, ownerAnswerTurnId } from '../projects/project-open-item';
import { projectStartedTurnId } from '../projects/project-started';
import { BACKGROUND_WAKE_TURN_PREFIX } from '../runner-api/background-job-wake';
import { ownerSendBackClientTurnId } from '../tasks/task-owner-confirmation';
import { TASK_ACCEPTANCE_CLIENT_TURN_PREFIX } from '../tasks/executable-acceptance-round';
import { taskRunResumeTurnId } from '../tasks/task-run-identity';
import { isOrbitAuthoredTurn } from './orbit-authored-turn';
import { WATCH_TURN_KEY_PREFIX } from './watch-turn-key';

/**
 * Which queued turns a client may hand back to the composer is decided here, by the key a turn was
 * filed under. Each key below is built by the function its writer builds it with, so a writer that
 * moves to another namespace turns this red instead of putting its words in somebody's composer.
 */

const ID = '44444444-4444-4444-8444-444444444444';
const SESSION = '11111111-1111-4111-8111-111111111111';

test('every turn the control plane files on its own account is recognised', () => {
  const written: Array<[string, string]> = [
    ['a watch wake', `${WATCH_TURN_KEY_PREFIX}${ID}:1`],
    ['a background job wake', `${BACKGROUND_WAKE_TURN_PREFIX}bgj_10bca948d369:exit`],
    ['a due wakeup', `${BACKGROUND_WAKE_TURN_PREFIX}wakeup:${ID}`],
    ['an exception item delivery', openItemTurnId(ID, new Date('2026-09-25T03:30:26.000Z'))],
    ["the owner's answer, as the coordinator is told it", ownerAnswerTurnId(ID, SESSION)],
    ['a project start', projectStartedTurnId(ID, { by: 'SWITCH', configRevision: 'rev-1', at: new Date() })],
    ["a task run's brief", taskRunResumeTurnId('press-1', SESSION)],
    ['an acceptance round', `${TASK_ACCEPTANCE_CLIENT_TURN_PREFIX}${ID}:0`],
    ["a coordinator's wake delivery", coordinatorDeliveryTurnId('wake-key-1')],
    ["a criteria decision's reply", criteriaDecisionReplyTurnId(ID)],
  ];
  for (const [what, key] of written) assert.equal(isOrbitAuthoredTurn(key), true, what);
});

test('a key somebody chose is theirs, whoever chose it', () => {
  const sent: Array<[string, string | null | undefined]> = [
    ['the browser', randomUUID()],
    ['the iOS and macOS apps', randomUUID().toUpperCase()],
    ['an agent', 'coord-e-seq208-status'],
    // The owner's own words, typed into the composer that a confirmation armed.
    ['a confirmation sent back', ownerSendBackClientTurnId(ID)],
    // A server turn id, which is UUIDv7: an agent repeating one it read is still an agent.
    ['a turn id repeated as a key', '01a0d6a9-d763-70e1-b4cf-8793e971b511'],
    ['a key that only contains a prefix', `x${WATCH_TURN_KEY_PREFIX}${ID}:1`],
    ['no key', null],
    ['an empty key', ''],
  ];
  for (const [who, key] of sent) assert.equal(isOrbitAuthoredTurn(key), false, who);
});

test('the derived-id shape is the one derivedUuid writes, and only that', () => {
  for (let i = 0; i < 200; i++) assert.equal(isDerivedUuid(derivedUuid(`name-${i}`)), true);
  for (let i = 0; i < 200; i++) assert.equal(isDerivedUuid(randomUUID()), false);
  assert.equal(isDerivedUuid(derivedUuid('name').toUpperCase()), false, 'derivedUuid never writes uppercase');
});
