import { uuidToBase62 } from '@orbit/shared';

import { WakeFact } from './coordinator-wake';

/**
 * What a JUDGMENT session opens on — the one-shot conversation a committed fact wakes.
 *
 * WHY THIS IS NOT `coordinator-opening.ts`
 * ========================================
 * That one is the opening of a user-origin conversation, and it is written for a reader who will
 * answer it: it says "推进靠的是跟人对话" and "没有任何自动的环会替你决定什么时候动". Both are
 * true there and false here. This session was decided on by something automatic — a fact
 * `CoordinatorWakeService` claimed — and there is nobody on the other end of it. Reusing that
 * opening would open every judgment by telling it two things that are not so, which is the mistake
 * 60dece5e removed from the OLD opening (it described a §9.2 policy matrix no code enforced any
 * more) and worth not making a second time.
 *
 * FACTS FIRST; ONE CLOSED PROTOCOL FOR PROJECT SETTLEMENT
 * ======================================================
 * Every opening says three things before it can prescribe anything:
 *
 *   1. what happened — the fact, rendered from `WakeFact` and from nothing else;
 *   2. where the full state is — the two reads, named with this project's id already in them;
 *   3. what is in reach — the tools, and the ones that are not.
 *
 * The generic events do not say what to conclude or do: the state this judgment is about is in the
 * database, not in this prompt. `PROJECT_TASKS_SETTLED` is the deliberate exception added by T7.
 * That event has a closed acceptance protocol whose ORDER is itself an invariant: code lands on
 * main, merge evidence is recorded, and only then may an acceptance run freeze the facts. This
 * does not pre-decide a verdict; it prevents a verdict from being formed against the wrong digest.
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
 * T7's settlement-only action protocol.
 *
 * It is conditional rather than part of every judgment opening: an attempt-budget wake has no
 * reason to open an acceptance run, while a project-settled wake exists specifically because the
 * old system stopped after the last task and left `runs: []` forever.
 */
export function settledAcceptanceProtocol(projectId: string): string {
  return (
    '\n\n这条 PROJECT_TASKS_SETTLED 事实要闭合项目验收；按下面的顺序行动，顺序是硬约束，不是建议：\n'
    + `1. 先用 project_acceptance（projectId 传 ${projectId}）读取验收标准、runs、mergeEvidence 和 doneGate。\n`
    + '2. 先确认实现已经真正落到 main，并且 main 上的行为满足验收对象。任务标成 DONE 只说明某个工作分支做完了，'
    + '不证明 main 已包含它。只要代码还没落 main，或者 mergeEvidence 为空，就开一条“合并并录入主干证据”的任务'
    + '（task_create 必须带对应 criterionKey），无法安全开任务时就在相关 task_comment 中升级给人；然后结束本轮。'
    + '这种情况下不得开 acceptance run，更不得写 PASS。\n'
    + '3. 合并任务的执行顺序必须是：合并到 main → 用 project_merge_evidence 记录 main 的当前内容证据 → 将任务置于终态。'
    + 'project_merge_evidence 会自动推进证据版本；已有结论不会被标成 stale，也不需要谁重开 attempt。\n'
    + '4. 只有确认 main 已落地且 mergeEvidence 已存在并对应当前 main，才用 project_acceptance_run 求值当前证据版本；'
    + '这个调用是幂等的，并发判断会拿到同一个版本。随后按清单逐条检查，并用 project_acceptance_verdict '
    + '提交每一条标准的结论事件和可复查证据，'
    + '不能漏项。\n'
    + '5. 服务端的判断会话角色边界仍然有效：这次判断可以完整提交全为 FAIL/INCONCLUSIVE 的 verdict；只要任何一条应为 '
    + 'PASS，就不得用假的 INCONCLUSIVE 绕过，也不能自己写 PASS。把每条候选 PASS 的证据写入相关 task_comment 并升级给人，'
    + '由账号所有者通道提交 PASS。无论 verdict 如何，project_update 的 status=DONE 都由账号所有者通道写。'
    + 'PASS 事件会留下 actor、时间和证据；DONE 会留下绑定的 run、digest 和时间但不记请求者。'
    + '这些记录都不证明持有凭据的一定是真人。\n\n'
    + '验收顺序再确认一次：合并到 main → project_merge_evidence → project_acceptance_run（幂等求值）→ '
    + 'project_acceptance_verdict；缺主干或缺 mergeEvidence 时停在开任务/升级。'
  );
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
    + '手上有哪些工具：读——project_get、task_list、task_get、session_list、session_get、project_acceptance；'
    + '写——task_create、task_update、task_comment、task_start、project_update、project_merge_evidence、'
    + 'project_acceptance_run、project_acceptance_verdict。\n\n'
    + '写的时候有三条边界，服务端会照着拒（不是建议）：'
    + '① 开新任务必须用 criterionKey 说明它服务于哪一条验收标准（project_get 里每条标准的 key），'
    + '并受这个项目每天能开多少个任务的预算限制；'
    + '② 验收标准你改不了，PASS 你也写不了——判定「做完了」的那把尺子和那个结论都归账号所有者通道；'
    + '③ 项目的 status=DONE 不由你写。'
    + '这三条是判断会话的角色隔离和按动作留痕，不是对“真人在场”的密码学证明；'
    + '把发现和还差什么写进 task_comment，账号所有者会读到。\n\n'
    + '没给你的工具就别去找：列出或删除项目、直接指挥 runner，都不在你手上。'
    + (fact.event === 'PROJECT_TASKS_SETTLED' ? settledAcceptanceProtocol(projectId) : '')
    + '\n\n'
    + '同一个项目还有一条人点开的协调会话，长期开着、由人驱动。它和这次判断读库里同一份事实，不共享上下文；'
    + '这次判断不会动它，它也不会动这次判断。'
  );
}
