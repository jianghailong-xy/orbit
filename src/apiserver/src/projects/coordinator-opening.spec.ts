import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import {
  buildCoordinatorDeliveryInstructions,
  buildCoordinatorInstructions,
  buildCoordinatorOpening,
  buildDelegatedCoordinatorNotice,
  coordinatorOpeningIsCurrent,
  coordinatorSessionTitle,
  hasCoordinatorOpening,
} from './coordinator-opening';

const PROJECT_ID = '0192f0d0-0000-7000-8000-000000000001';

/** Both forms a coordinator reads its role in, for one setting of the project's Automatic switch. */
function formsOf(coordinatorEnabled: boolean): string[] {
  return [
    buildCoordinatorInstructions('Crawl the corpus', PROJECT_ID, coordinatorEnabled),
    buildCoordinatorDeliveryInstructions(PROJECT_ID, coordinatorEnabled),
  ];
}

const EVERY_FORM = [...formsOf(true), ...formsOf(false)];

test('a project coordinator session is titled with the project name', () => {
  assert.equal(coordinatorSessionTitle('Ship the coordinator'), 'Ship the coordinator');
});

test('a project coordinator session keeps the exact project title', () => {
  assert.equal(coordinatorSessionTitle('x'.repeat(240)), 'x'.repeat(240));
});

// All three paths that hand a session the coordinator role share one instruction body, so what it
// says about the work that turns up HERE has to hold in all three. The delivery form is the one
// that repeats every turn, and is therefore the one a coordinator re-reads before it proposes.
test('every form of the coordinator role files new work as tasks, and prices opening a project', () => {
  for (const form of EVERY_FORM) {
    // Still the default and still first: ordinary new work belongs to the project it turned up in.
    assert.match(form, /record it as a task under this project/);
    // Opening one is allowed — the confirmation card is the owner's answer — but the reason
    // travels with the permission: the new project is coordinated by a conversation of its own,
    // which knows none of this one, so what the coordinator writes is all it inherits.
    assert.match(form, /you may open a new project/);
    assert.match(form, /a session coordinates only one project/);
    assert.match(form, /opens a coordinator session of its own for it/);
  }
});

// `task_start` is refused until the owner starts the project, and a coordinator that learns it
// only from the refusal has already told the owner its tasks are running. The owner's card appears
// only once the coordinator asks, so every form also says how to ask — and when.
test('every form of the coordinator role says the start is the owner’s, and how to ask for it', () => {
  for (const form of EVERY_FORM) {
    assert.match(form, /Until the project has started, task_start is refused/);
    assert.match(form, /once the plan is written and every acceptance criterion has a task serving it \(task_create with criterionKey\), request the start with project_request_start/);
    assert.match(form, /if it fails, it says why, reason by reason/);
    assert.match(form, /Wait until Orbit tells you the project has started before starting tasks/);
  }
});

// Automatic on: the owner has already authorized the project to move by itself, so a coordinator
// that asks the owner to settle each task — or declares OWNER_CONFIRMED to have them do it — puts
// back exactly the confirmations the switch took away.
test('with Automatic on, the coordinator is told it judges task completion, and when the owner is needed', () => {
  for (const form of formsOf(true)) {
    assert.match(form, /This project has Automatic on/);
    // Who settles a task, per criterion.
    assert.match(form, /whether a task is done is yours to judge, not something the account owner confirms card by card/);
    assert.match(form, /the platform judges EXECUTABLE and VERIFICATION by itself/);
    assert.match(
      form,
      /for EVIDENCE_JUDGMENT you read the evidence and decide CONFIRM or SEND_BACK with task_evidence_decide/,
    );
    assert.match(
      form,
      /Do not declare OWNER_CONFIRMED on a task unless the project criterion it serves itself says the account owner confirms it/,
    );
    // The owner, and only for these.
    assert.match(
      form,
      /Only three kinds of matter need the account owner: changing or confirming the acceptance criteria; authorizing a launch or an irreversible step in advance; and a trade-off that truly needs the account owner’s decision/,
    );
    assert.match(form, /Send each decision as a question with ask_owner, each with the default you recommend/);
    assert.match(form, /where you can move forward on the default, move forward on it rather than stopping to wait/);
    // A failed landing of a DONE task is the coordinator's to rerun or send back (J-T1b), and
    // task_start is named as the door that does NOT do it.
    assert.match(form, /task_start does not queue the landing again/);
    assert.match(form, /queue it once more with integration_retry and a reason; a problem in the delivery itself is sent back for rework with task_reopen/);
    assert.match(form, /use task_create and attach it to the open item with fixesOpenItemId/);
    assert.match(form, /cancel it, then task_create with supersedesTaskId/);
    assert.match(form, /Whether such a landing goes ahead is yours to judge, not a question for the account owner/);
    // A blocked merge into main names no task, and goes through the same door with the candidate's
    // id — the merge itself staying the owner's or the Automatic setting's (§4.7 H1) — and a rerun
    // leaves its item open, being handled, until its result is in.
    assert.match(form, /use integration_retry the same way, passing promotionId to rerun that candidate’s check; the merge itself is still confirmed by the account owner or the Automatic setting/);
    assert.match(form, /ask with ask_owner, giving at least two options/);
    assert.match(form, /handed to the account owner with open_item_hand_over, with an explanation/);
    // Revision 13 (§4.6, §4.4 X-D4 5): an item the coordinator took up stays its own, what needs the
    // owner is asked, and a landed fix brings the item back to be closed or rerun.
    assert.match(form, /Once you take up an open item it stays yours,\s*and the platform does not hand it to the account owner because time ran out/);
    assert.match(form, /anything that needs the account owner’s decision while you handle an item is asked with ask_owner too, and the item stays with you/);
    assert.match(form, /After a fix task attached to an open item lands, the platform delivers the item again/);
    assert.doesNotMatch(form, /leaves it unhandled for longer than the project’s/);
    assert.match(form, /After a requeue or rerun the item shows as being handled, and only when the result is in is it marked handled \(HANDLED\) or superseded by a new failure/);
    // And not the conversational stance, whose second sentence is false with the switch on: wakes,
    // auto-run dispatch and the automatic merge into main all act on this project.
    assert.doesNotMatch(form, /Progress comes from talking with people/);
    assert.doesNotMatch(form, /No automatic loop decides for you when to act/);
  }
});

test('with Automatic off, the coordinator keeps the conversational text and no Automatic division', () => {
  for (const form of formsOf(false)) {
    assert.match(
      form,
      /Progress comes from talking with people: say clearly where things stand, ask what needs asking, agree on the next step, then act\. No automatic loop decides for you when to act\./,
    );
    assert.match(form, /Both are recorded through the account owner’s channel — say clearly what should change and what is still missing, and let the account owner at the screen decide/);
    assert.doesNotMatch(form, /Automatic/);
    assert.doesNotMatch(form, /whether a task is done is yours to judge/);
    assert.doesNotMatch(form, /task_evidence_decide/);
    assert.doesNotMatch(form, /Only three kinds of matter need the account owner/);
    assert.doesNotMatch(form, /ask_owner/);
    // Without the switch a failed landing is the owner's from the start, so the coordinator is not
    // told it decides one.
    assert.doesNotMatch(form, /integration_retry/);
  }
});

// "Two things are not yours to decide: … recording it as DONE" was about the project, and was read
// as being about its tasks too — the step from there to OWNER_CONFIRMED on a task is short.
test('the DONE a coordinator does not decide is the project’s, in both modes', () => {
  for (const form of EVERY_FORM) {
    assert.match(form, /Two things are not yours to decide: changing this project’s acceptance criteria, and recording this project as DONE\./);
    assert.doesNotMatch(form, /recording it as DONE/);
    assert.match(form, /The DONE meant here is the project’s own, not that of any of its tasks: whether a task is done goes by the completion criterion it declared\./);
    // Every sentence that says DONE says whose it is.
    const sentences = form.split(/\.\s|\n/).filter((sentence) => sentence.includes('DONE'));
    assert.ok(sentences.length > 0);
    for (const sentence of sentences) {
      assert.match(sentence, /project/, `a DONE sentence that does not name the project: ${sentence}`);
    }
  }
});

test('the two texts differ, so the switch is part of what a coordinator is told', () => {
  assert.notEqual(
    buildCoordinatorDeliveryInstructions(PROJECT_ID, true),
    buildCoordinatorDeliveryInstructions(PROJECT_ID, false),
  );
});

// The opening is the prompt a coordinator was created with, so the ones created before the copy
// was English still open in Chinese. Both are the role already given, and only for their own project.
test('an opening is recognized by the project id in its identity sentence, in English and in the Chinese of older openings', () => {
  const other = '0192f0d0-0000-7000-8000-000000000002';
  const opening = buildCoordinatorOpening('Crawl the corpus', PROJECT_ID, false);
  assert.equal(hasCoordinatorOpening(opening, PROJECT_ID), true);
  assert.equal(hasCoordinatorOpening(opening, other), false);
  assert.equal(hasCoordinatorOpening(buildCoordinatorDeliveryInstructions(PROJECT_ID, true), PROJECT_ID), true);

  const older = `你是项目「Crawl the corpus」（id: ${uuidToBase62(PROJECT_ID)}）的协调会话。\n\n`
    + '这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。';
  assert.equal(hasCoordinatorOpening(older, PROJECT_ID), true);
  assert.equal(hasCoordinatorOpening(older, other), false);
  // It is the role, not today's rendering of it: the delivery puts the English instructions in front
  // of such a coordinator once.
  assert.equal(coordinatorOpeningIsCurrent(older, PROJECT_ID, false), false);
  assert.equal(coordinatorOpeningIsCurrent(opening, PROJECT_ID, false), true);

  // Being told a project was recorded under another conversation is not that conversation's role.
  const notice = buildDelegatedCoordinatorNotice('Crawl the corpus', PROJECT_ID, other);
  assert.equal(hasCoordinatorOpening(notice, PROJECT_ID), false);
});
