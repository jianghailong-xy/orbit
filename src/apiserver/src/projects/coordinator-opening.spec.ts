import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCoordinatorDeliveryInstructions,
  buildCoordinatorInstructions,
  coordinatorSessionTitle,
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
    assert.match(form, /记成这个项目下的任务/);
    // Opening one is allowed — the confirmation card is the owner's answer — but the reason
    // travels with the permission: the new project is coordinated by a conversation of its own,
    // which knows none of this one, so what the coordinator writes is all it inherits.
    assert.match(form, /可以开新项目/);
    assert.match(form, /一个会话只能协调一个项目/);
    assert.match(form, /另开一条自己的协调会话/);
  }
});

// `task_start` is refused until the owner starts the project, and a coordinator that learns it
// only from the refusal has already told the owner its tasks are running. The owner's card appears
// only once the coordinator asks, so every form also says how to ask — and when.
test('every form of the coordinator role says the start is the owner’s, and how to ask for it', () => {
  for (const form of EVERY_FORM) {
    assert.match(form, /项目开工之前 task_start 会被拒/);
    assert.match(form, /计划写好、每条验收标准都有任务服务（task_create 带 criterionKey）之后，用 project_request_start 请求启动/);
    assert.match(form, /不通过会逐条说原因/);
    assert.match(form, /等 Orbit 告诉你项目已开工再启动任务/);
  }
});

// Automatic on: the owner has already authorized the project to move by itself, so a coordinator
// that asks the owner to settle each task — or declares OWNER_CONFIRMED to have them do it — puts
// back exactly the confirmations the switch took away.
test('with Automatic on, the coordinator is told it judges task completion, and when the owner is needed', () => {
  for (const form of formsOf(true)) {
    assert.match(form, /这个项目开着 Automatic/);
    // Who settles a task, per criterion.
    assert.match(form, /任务做没做完由你判，不交给账号所有者逐张确认/);
    assert.match(form, /EXECUTABLE 和 VERIFICATION 由平台自动判/);
    assert.match(
      form,
      /EVIDENCE_JUDGMENT 由你读完证据后用 task_evidence_decide 判 CONFIRM 或 SEND_BACK/,
    );
    assert.match(
      form,
      /不要给任务声明 OWNER_CONFIRMED，除非它服务的那条项目判据自己写明要账号所有者确认/,
    );
    // The owner, and only for these.
    assert.match(
      form,
      /要找账号所有者的只有三类：改或确认验收标准；上线与不可逆操作的事前授权；真正要账号所有者拍板的取舍/,
    );
    assert.match(form, /拍板题用 ask_owner 发，每题附上你推荐的默认/);
    assert.match(form, /能按默认推进的就按默认推进，别停下来等/);
    // A failed landing of a DONE task is the coordinator's to rerun or send back (J-T1b), and
    // task_start is named as the door that does NOT do it.
    assert.match(form, /task_start 不会重新排落地/);
    assert.match(form, /用 integration_retry 带理由重排一次，交付本身的问题用 task_reopen 退回返工/);
    assert.match(form, /task_create，并把 fixesOpenItemId 挂到这条待办/);
    assert.match(form, /取消后 task_create 带 supersedesTaskId/);
    assert.match(form, /这类落地去留由你判，不拿去问账号所有者/);
    // A blocked merge into main names no task, and goes through the same door with the candidate's
    // id — the merge itself staying the owner's or the Automatic setting's (§4.7 H1) — and a rerun
    // leaves its item open, being handled, until its result is in.
    assert.match(form, /同样用 integration_retry，传 promotionId 重跑那个候选的检查；合并本身仍由账号所有者或 Automatic 设置确认/);
    assert.match(form, /用 ask_owner 带至少两个选项提问/);
    assert.match(form, /用 open_item_hand_over 带说明交给账号所有者/);
    assert.match(form, /重排或重跑之后待办显示为处理中，结果出来才标为已处理（HANDLED），或被新的失败取代/);
    // And not the conversational stance, whose second sentence is false with the switch on: wakes,
    // auto-run dispatch and the automatic merge into main all act on this project.
    assert.doesNotMatch(form, /推进靠的是跟人对话/);
    assert.doesNotMatch(form, /没有任何自动的环会替你决定什么时候动/);
  }
});

test('with Automatic off, the coordinator keeps the conversational text and no Automatic division', () => {
  for (const form of formsOf(false)) {
    assert.match(
      form,
      /推进靠的是跟人对话：把现状说清楚，该问的问，商量下一步，然后动手。没有任何自动的环会替你决定什么时候动。/,
    );
    assert.match(form, /这两件都由账号所有者通道记录——你把该改什么、还差什么说清楚，让屏幕这边的账号所有者决定/);
    assert.doesNotMatch(form, /Automatic/);
    assert.doesNotMatch(form, /任务做没做完由你判/);
    assert.doesNotMatch(form, /task_evidence_decide/);
    assert.doesNotMatch(form, /要找账号所有者的只有三类/);
    assert.doesNotMatch(form, /ask_owner/);
    // Without the switch a failed landing is the owner's from the start, so the coordinator is not
    // told it decides one.
    assert.doesNotMatch(form, /integration_retry/);
  }
});

// "有两件事不是你来定：…把它记成 DONE" was about the project, and was read as being about its tasks
// too — the step from there to OWNER_CONFIRMED on a task is short.
test('the DONE a coordinator does not decide is the project’s, in both modes', () => {
  for (const form of EVERY_FORM) {
    assert.match(form, /有两件事不是你来定：改这个项目的验收标准，和把这个项目记成 DONE。/);
    assert.doesNotMatch(form, /把它记成 DONE/);
    assert.match(form, /这里说的 DONE 是项目本身的，不是它下面某个任务的：任务做没做完，按各自声明的完成判据走。/);
    // Every sentence that says DONE says whose it is.
    const sentences = form.split(/[。\n]/).filter((sentence) => sentence.includes('DONE'));
    assert.ok(sentences.length > 0);
    for (const sentence of sentences) {
      assert.match(sentence, /项目/, `a DONE sentence that does not name the project: ${sentence}`);
    }
  }
});

test('the two texts differ, so the switch is part of what a coordinator is told', () => {
  assert.notEqual(
    buildCoordinatorDeliveryInstructions(PROJECT_ID, true),
    buildCoordinatorDeliveryInstructions(PROJECT_ID, false),
  );
});
