import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COORDINATOR_HANDOFF_SECTIONS } from '@orbit/shared';

import { coordinatorHandoffPrompt } from './coordinator-handoff';
import { autoRulingFromAnswer, isOwnerTextTurn, quoteIsInOwnerText } from './project-ruling';

test('the note sections are Where things stand, Rulings not yet recorded, Waiting on, Next', () => {
  assert.deepEqual([...COORDINATOR_HANDOFF_SECTIONS], ['Where things stand', 'Rulings not yet recorded', 'Waiting on', 'Next']);
});

test('the note prompt asks to record unrecorded rulings first, then to write the note in the four sections', () => {
  const prompt = coordinatorHandoffPrompt();
  assert.ok(prompt.startsWith('From Orbit · handoff note'));
  const record = prompt.indexOf('First, record the owner\'s rulings.');
  const note = prompt.indexOf('Then write the handoff note');
  assert.ok(record > 0, 'the prompt does not ask to record rulings');
  assert.ok(note > record, 'recording rulings does not come before the note');
  assert.match(prompt, /call project_ruling_record with the ruling in one sentence/);
  assert.match(prompt, /pass the old one's id as supersedes/);
  assert.match(prompt, /Answered ask_owner questions are recorded already\./);
  assert.match(prompt, /Apart from project_ruling_record, do not start, change or file anything in this turn/);
  // The four titles, each on a line of its own, in order, after the request for the note.
  const titles = prompt.split('\n\n').find((block) => block.split('\n')[0] === 'Where things stand');
  assert.deepEqual(titles?.split('\n'), ['Where things stand', 'Rulings not yet recorded', 'Waiting on', 'Next']);
  assert.ok(prompt.indexOf(titles!) > note);
  assert.doesNotMatch(prompt, /Agreed with the owner/);
});

test('an answered question\'s ruling is the question with the chosen option; the owner\'s answer is the quote', () => {
  const question = { question: 'Ship Android first?', options: [{ label: 'Yes' }, { label: 'No, together' }] };
  assert.deepEqual(autoRulingFromAnswer(question, { option: 1 }), { ruling: 'Ship Android first? — No, together', quote: 'No, together' });
  assert.deepEqual(autoRulingFromAnswer(question, { option: 0, text: ' Yes, this week. ' }), { ruling: 'Ship Android first? — Yes', quote: 'Yes, this week.' });
  assert.deepEqual(autoRulingFromAnswer(question, { text: 'Ask me on Monday.' }), { ruling: 'Ship Android first?', quote: 'Ask me on Monday.' });
  assert.equal(autoRulingFromAnswer(question, {}), null);
});

test('a quote is found in the owner text with whitespace read as a person reads it, and a short one proves nothing', () => {
  assert.equal(quoteIsInOwnerText('Don\'t merge   it\nbefore Friday.', 'merge it before Friday'), true);
  assert.equal(quoteIsInOwnerText('Don\'t merge it before Friday.', 'merge it after Friday'), false);
  assert.equal(quoteIsInOwnerText('ok', 'ok'), false);
});

test('owner text is a message or steer that no session sent and Orbit did not write', () => {
  const session = { id: 's', promptByOrbit: false };
  const turn = { kind: 'message', clientTurnId: 'web-1', senderSessionId: null, content: 'Do it.' };
  assert.equal(isOwnerTextTurn(session, turn), true);
  assert.equal(isOwnerTextTurn(session, { ...turn, kind: 'steer' }), true);
  assert.equal(isOwnerTextTurn(session, { ...turn, kind: 'interrupt' }), false);
  assert.equal(isOwnerTextTurn(session, { ...turn, senderSessionId: 'other' }), false);
  assert.equal(isOwnerTextTurn(session, { ...turn, clientTurnId: 'coordinator-handoff:v1:h:1' }), false);
  assert.equal(isOwnerTextTurn(session, { ...turn, content: null }), false);
});
