import { uuidToBase62 } from '@orbit/shared';

import { WakeFact } from './coordinator-wake';

/**
 * What a JUDGMENT session opens on — the one-shot conversation a committed fact wakes.
 *
 * WHY THIS IS NOT `coordinator-opening.ts`
 * ========================================
 * That one is the opening of a conversation a PERSON opened, and it is written for a reader who
 * will answer it: it says "推进靠的是跟人对话" and "没有任何自动的环会替你决定什么时候动". Both are
 * true there and false here. This session was decided on by something automatic — a fact
 * `CoordinatorWakeService` claimed — and there is nobody on the other end of it. Reusing that
 * opening would open every judgment by telling it two things that are not so, which is the mistake
 * 60dece5e removed from the OLD opening (it described a §9.2 policy matrix no code enforced any
 * more) and worth not making a second time.
 *
 * FACTS, NOT INSTRUCTIONS
 * =======================
 * This says three things and deliberately no fourth:
 *
 *   1. what happened — the fact, rendered from `WakeFact` and from nothing else;
 *   2. where the full state is — the two reads, named with this project's id already in them;
 *   3. what is in reach — the tools, and the ones that are not.
 *
 * It does not say what to conclude, what to do about it, or in what order. That is not restraint
 * for its own sake: the state this judgment is about is in the database, not in this prompt, and a
 * prompt that prescribes an action has decided the thing before the reader has read anything. The
 * whole reason the session is opened fresh per fact — rather than steered into a standing one — is
 * that the judgment should be a function of what is committed. Baking an instruction in makes it a
 * function of what this file guessed.
 *
 * The one thing said about the session itself — that it is for this fact and lasts one turn — is a
 * property of the mechanism, not an instruction. It is here because a reader that assumed it could
 * ask a question and wait would be wrong about the world it is in.
 */

/** The title a judgment session is filed under, next to `coordinatorSessionTitle`'s `协调：`. */
export function judgmentSessionTitle(projectTitle: string): string {
  return `判断：${projectTitle}`.slice(0, 80);
}

/**
 * The fact, in one sentence, per event.
 *
 * Rendered from the fact's own fields — `detail` is read here and only here, which is the reader
 * `coordinator-wake.ts` says it is for ("display and diagnosis, never an input to anything"). Ids
 * go out in Base62 because that is the spelling every tool this session can call takes back.
 *
 * The default arm is not dead code: `COORDINATOR_WAKE_EVENTS` is a closed set today, and a fifth
 * member added without a sentence here should open its session saying so rather than saying
 * nothing.
 */
export function describeWakeFact(fact: WakeFact): string {
  const detail = (fact.detail ?? {}) as Record<string, unknown>;
  switch (fact.event) {
    case 'ATTEMPT_ENDED_UNSETTLED':
      return (
        `任务 ${uuidToBase62(fact.subjectId)} 的一次会话结束了，而这个任务当时的状态是 ` +
        `${String(detail.taskStatus ?? '未知')}——不是终态。`
      );
    case 'ATTEMPT_BUDGET_SPENT':
      return (
        `任务 ${uuidToBase62(fact.subjectId)} 的一次尝试用完了 ${String(detail.dimension ?? '某一条')} ` +
        '这条 attempt 预算。'
      );
    case 'PROJECT_TASKS_SETTLED':
      return `这个项目下的 ${String(detail.taskCount ?? '全部')} 个任务都到了终态（DONE 或 CANCELLED）。`;
    case 'CRITERION_READY':
      return (
        `服务验收标准 ${String(detail.criterionKey ?? fact.subjectId)} 的 ` +
        `${String(detail.taskCount ?? '全部')} 个任务都 DONE 了。`
      );
    default:
      return `发生了 ${fact.event}，主体是 ${fact.subjectType} ${fact.subjectId}。`;
  }
}

/**
 * The message a judgment session opens on.
 *
 * `title` and the fact are the ONLY project state in here. Everything else about the project —
 * its goal, its acceptance criteria, its instructions, where each task stands — is a read this
 * session makes for itself, and the prompt says which read. Copying any of it in would freeze it
 * at the moment the fact was claimed, which is before this session runs.
 */
export function buildJudgmentOpening(fact: WakeFact, projectTitle: string): string {
  const projectId = uuidToBase62(fact.projectId);
  return (
    `你是项目「${projectTitle}」（id: ${projectId}）的一次判断会话。\n\n`
    + `发生了什么：${describeWakeFact(fact)}\n\n`
    + '这次会话是为上面这一个事实开出的，只有这一轮：它不接着上一次判断的上下文，也不会有人接着往里发消息。'
    + '项目的状态在库里，不在这段对话里——这段开场白里除了上面那条事实，没有这个项目的任何其他状态。\n\n'
    + `去哪读全量状态：project_get（projectId 传 ${projectId}）给出这个项目的目标、验收标准、作业指导和状态；`
    + `task_list（projectId 传 ${projectId}）给出它下面每个任务的状态、验收标准和依赖；`
    + 'task_get 给出某个任务的完整描述和历史评论。\n\n'
    + '手上有哪些工具：读——project_get、task_list、task_get、session_list、session_get；'
    + '写——task_create、task_update、task_comment、task_start、project_update。\n\n'
    + '没给你的工具就别去找：列出或删除项目、直接指挥 runner，都不在你手上。\n\n'
    + '同一个项目还有一条人点开的协调会话，长期开着、由人驱动。它和这次判断读库里同一份事实，不共享上下文；'
    + '这次判断不会动它，它也不会动这次判断。'
  );
}
