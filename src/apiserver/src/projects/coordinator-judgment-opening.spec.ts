import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';

import { buildCoordinatorOpening } from './coordinator-opening';
import {
  buildJudgmentOpening,
  describeWakeFact,
  judgmentSessionTitle,
} from './coordinator-judgment-opening';
import {
  WakeFact,
  attemptBudgetSpentFact,
  attemptEndedUnsettledFact,
  criterionReadyFact,
  projectTasksSettledFact,
} from './coordinator-wake';

const PROJECT = randomUUID();
const TASK = randomUUID();
const SESSION = randomUUID();

const ENDED = attemptEndedUnsettledFact({
  projectId: PROJECT,
  taskId: TASK,
  taskStatus: 'IN_PROGRESS',
  sessionId: SESSION,
})!;

test('the opening says what happened, and says it from the fact rather than from the project', () => {
  const opening = buildJudgmentOpening(ENDED, '协调重做');

  assert.match(opening, /发生了什么：/);
  // The task's id, in the spelling every tool this session can call takes back.
  assert.match(opening, new RegExp(uuidToBase62(TASK)));
  assert.match(opening, /不是终态/);
  // The status came out of `detail`, which is the only reader that field is for.
  assert.match(opening, /IN_PROGRESS/);
  // Raw uuids are not a spelling anything here accepts, so neither id may go out as one.
  assert.doesNotMatch(opening, new RegExp(TASK));
  assert.doesNotMatch(opening, new RegExp(PROJECT));
});

test('the opening names where the full state is read, with this project’s id already in it', () => {
  const opening = buildJudgmentOpening(ENDED, '协调重做');
  const projectId = uuidToBase62(PROJECT);

  assert.match(opening, new RegExp(`project_get（projectId 传 ${projectId}）`));
  assert.match(opening, new RegExp(`task_list（projectId 传 ${projectId}）`));
  assert.match(opening, /task_get/);
});

test('the opening names the tools that are in reach, and the ones that are not', () => {
  const opening = buildJudgmentOpening(ENDED, '协调重做');
  for (const tool of ['project_get', 'task_list', 'task_get', 'session_list', 'session_get',
    'task_create', 'task_update', 'task_comment', 'task_start', 'project_update']) {
    assert.match(opening, new RegExp(tool), `the opening must name ${tool}`);
  }
  assert.match(opening, /没给你的工具就别去找/);
});

/**
 * The rule the task states outright: the opening gives FACTS, not instructions.
 *
 * Asserted as the absence of the two sentences the conversational opening uses to tell its reader
 * what to do — they are the concrete thing that would be copied across if this file were ever
 * rewritten by starting from that one, and both are false here. There is nobody to talk to, and
 * something automatic is exactly what decided this session should exist.
 */
test('the opening does not instruct, and does not repeat the two sentences that are false here', () => {
  const opening = buildJudgmentOpening(ENDED, '协调重做');

  assert.doesNotMatch(opening, /没有任何自动的环会替你决定什么时候动/);
  assert.doesNotMatch(opening, /推进靠的是跟人对话/);
  // No imperative about the work itself. "先读再说" is the conversational opening's, and "你应该"
  // is the shape any later edit would most likely reach for.
  assert.doesNotMatch(opening, /先读再说/);
  assert.doesNotMatch(opening, /你应该|你需要|请先|接下来你/);
});

test('the opening states the two facts about the session itself: one fact, one turn', () => {
  const opening = buildJudgmentOpening(ENDED, '协调重做');

  assert.match(opening, /只有这一轮/);
  assert.match(opening, /不会有人接着往里发消息/);
  // And that the person's conversation is a different one over the same database.
  assert.match(opening, /不共享上下文/);
});

test('the opening carries no project state beyond the title and the fact', () => {
  const opening = buildJudgmentOpening(ENDED, '协调重做');
  // Everything a coordinator needs is a read, named above. Copying any of it in would freeze it at
  // the moment the fact was claimed, which is before this session runs.
  assert.doesNotMatch(opening, /验收标准是|目标是|作业指导是/);
  assert.match(opening, /这段开场白里除了上面那条事实，没有这个项目的任何其他状态/);
});

test('every wake event has a sentence of its own', () => {
  const budget = attemptBudgetSpentFact({
    projectId: PROJECT, taskId: TASK, sessionId: SESSION, dimension: 'COORDINATOR_STEERS',
  });
  const settled = projectTasksSettledFact(PROJECT, [
    { taskId: TASK, status: 'DONE' },
    { taskId: randomUUID(), status: 'CANCELLED' },
  ])!;
  const criterion = criterionReadyFact(PROJECT, 'ab12', [{ taskId: TASK, status: 'DONE' }])!;

  assert.match(describeWakeFact(ENDED), /会话结束了/);
  assert.match(describeWakeFact(budget), /COORDINATOR_STEERS/);
  assert.match(describeWakeFact(settled), /2 个任务都到了终态/);
  assert.match(describeWakeFact(criterion), /ab12/);

  // A fifth event added without a sentence here opens its session saying so, rather than saying
  // nothing at all about why it exists.
  const unknown = { ...ENDED, event: 'SOMETHING_NEW' } as unknown as WakeFact;
  assert.match(describeWakeFact(unknown), /SOMETHING_NEW/);
});

test('PROJECT_TASKS_SETTLED carries the merge-evidence-run order and the no-evidence exit', () => {
  const settled = projectTasksSettledFact(PROJECT, [
    { taskId: TASK, status: 'DONE' },
  ])!;
  const opening = buildJudgmentOpening(settled, '验收闭环');

  for (const tool of [
    'project_acceptance',
    'project_merge_evidence',
    'project_acceptance_run',
    'project_acceptance_verdict',
  ]) {
    assert.match(opening, new RegExp(tool), `settlement judgment must be handed ${tool}`);
  }
  const merge = opening.lastIndexOf('合并到 main');
  const evidence = opening.lastIndexOf('project_merge_evidence');
  const run = opening.lastIndexOf('project_acceptance_run');
  const verdict = opening.lastIndexOf('project_acceptance_verdict');
  assert.ok(merge < evidence && evidence < run && run < verdict, 'the evidence order drifted');

  assert.match(opening, /mergeEvidence 为空/);
  assert.match(opening, /task_create.*criterionKey/);
  assert.match(opening, /task_comment 中升级给人/);
  assert.match(opening, /不得开 acceptance run，更不得写 PASS/);
  assert.match(opening, /任何主体都不能.*直接写 status=DONE/);
  assert.match(opening, /服务端自动产生 DONE/);
  assert.match(opening, /不证明持有凭据的一定是真人/);
  assert.match(opening, /不会被标成 stale/);
  assert.match(opening, /幂等/);
});

test('COMPLETION_ACK_STALE carries the autonomous repair protocol and only four human exits', () => {
  const obligationId = 'a'.repeat(64);
  const obligationRevision = 'b'.repeat(64);
  const turnId = randomUUID();
  const fact: WakeFact = {
    event: 'COMPLETION_ACK_STALE',
    projectId: PROJECT,
    subjectType: 'TASK',
    subjectId: TASK,
    subjectVersion: `delivery:${randomUUID()}`,
    detail: {
      obligationId,
      obligationRevision,
      binding: { turnId },
      reason: 'CONTROL_PLANE_COMMIT_REJECTED',
    },
  };
  const opening = buildJudgmentOpening(fact, '滚动升级修复');
  assert.match(opening, new RegExp(obligationId));
  assert.match(opening, new RegExp(obligationRevision));
  assert.match(opening, new RegExp(turnId));
  assert.match(opening, /mandatory remediation obligation/);
  assert.match(opening, /不得取消或重跑/);
  assert.match(opening, /不得直接写 Task\.status/);
  assert.match(opening, /不得放宽 writer fence/);
  assert.match(opening, /诊断、代码兼容修复、直接 PostgreSQL 回归、部署/);
  for (const authority of [
    'NEW_AUTHORIZATION', 'RISK_ACCEPTANCE', 'GOAL_DECISION', 'EXTERNAL_IDENTITY',
  ]) assert.match(opening, new RegExp(authority));
  assert.match(opening, /project_owner_decision_request/);
  for (const field of [
    'whyNotAgent', 'options', 'impacts', 'recommendation', 'noActionConsequence', 'cost',
    'deadline', 'resumeBehavior', 'idempotencyKey',
  ]) assert.match(opening, new RegExp(field));
  assert.match(opening, /不得用 task_comment、聊天文本或 HUMAN_SIGNOFF 代替/);
  assert.match(opening, /代码兼容缺陷、测试、部署和验证不属于这四类/);
});

test('a judgment session is filed under a different title from the conversation', () => {
  assert.equal(judgmentSessionTitle('协调重做'), '判断：协调重做');
  assert.ok(judgmentSessionTitle('x'.repeat(200)).length <= 80);
});

/**
 * The other half of "keep the person's coordinator untouched": this unit did not edit that opening
 * to make one file serve both. If a later change makes the conversational opening say something a
 * judgment needs, the answer is a second sentence here, not a shared one there.
 */
test('the conversation a person opens still opens the way 60dece5e restored it', () => {
  const conversational = buildCoordinatorOpening('协调重做', PROJECT);
  assert.match(conversational, /没有任何自动的环会替你决定什么时候动/);
  assert.match(conversational, /推进靠的是跟人对话/);
  assert.match(conversational, /先读再说/);
  assert.doesNotMatch(conversational, /发生了什么：/);
});

/** The reducer owns no clock; a separately supervised courier may re-deliver its durable fact. */
test('the judgment reducer owns no timer', () => {
  const here = path.resolve(__dirname, '..', '..', 'src', 'projects');
  for (const file of [
    'coordinator-judgment-opening.ts',
    'coordinator-judgment.service.ts',
    'project-tasks-settled.producer.ts',
  ]) {
    const source = readFileSync(path.join(here, file), 'utf8');
    for (const timer of ['setInterval', 'setTimeout', '@Interval', '@Cron', 'SchedulerRegistry']) {
      assert.ok(
        !source.includes(timer),
        `${file} must not own a timer, found ${timer} — a wake is a committed fact`,
      );
    }
  }
});
