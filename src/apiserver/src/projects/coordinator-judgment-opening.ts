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
 * That event has a closed protocol whose ORDER is itself an invariant: code lands on main, and
 * only then is merge evidence recorded. Migration 0229 removed the acceptance judgment this used
 * to end in, so the protocol now ends at the observation rather than at a verdict.
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
    case 'COMPLETION_ACK_STALE':
      {
        const binding = detail.binding && typeof detail.binding === 'object'
          && !Array.isArray(detail.binding)
          ? detail.binding as Record<string, unknown>
          : {};
        const structuredReason = detail.reason && typeof detail.reason === 'object'
          && !Array.isArray(detail.reason)
          ? detail.reason as Record<string, unknown>
          : null;
        const reason = typeof detail.reason === 'string'
          ? detail.reason
          : String(structuredReason?.message ?? 'completion ACK stale');
      return (
        `任务 ${uuidToBase62(fact.subjectId)} 的完成结果已经持久化，但控制面仍未确认 turn `
        + `${String(binding.turnId ?? detail.turnId ?? '未知')}；canonical obligation `
        + `${String(detail.obligationId ?? '未知')} / revision `
        + `${String(detail.obligationRevision ?? detail.bindingDigest ?? '未知')} `
        + `由项目 coordinator 负责，原因是 ${reason}。`
      );
      }
    default:
      return `发生了 ${fact.event}，主体是 ${fact.subjectType} ${fact.subjectId}。`;
  }
}

/**
 * T7's settlement-only action protocol.
 *
 * It is conditional rather than part of every judgment opening: an attempt-budget wake has no
 * reason to look at the target branch, while a project-settled wake exists specifically because
 * the old system stopped after the last task and never looked again.
 *
 * Migration 0229 removed the project acceptance judgment, so this protocol no longer ends in a
 * verdict. It ends where the evidence ends: has the work actually landed on main, and is that
 * recorded. Whether the project's stated criteria HOLD is a question nothing in Orbit answers now,
 * and the prompt says so rather than sending a session looking for a tool that is not there.
 */
export function settledAcceptanceProtocol(projectId: string): string {
  return (
    '\n\n这条 PROJECT_TASKS_SETTLED 事实要核对主干证据；按下面的顺序行动，顺序是硬约束，不是建议：\n'
    + `1. 先用 project_get（projectId 传 ${projectId}）读取这个项目声明的验收标准。\n`
    + '2. 确认实现已经真正落到 main，并且 main 上的行为满足验收对象。任务标成 DONE 只说明某个工作分支做完了，'
    + '不证明 main 已包含它。只要代码还没落 main，就开一条“合并并录入主干证据”的任务'
    + '（task_create 必须带对应 criterionKey），无法安全开任务时就在相关 task_comment 中升级给人；然后结束本轮。\n'
    + '3. 合并任务的执行顺序必须是：合并到 main → 用 project_merge_evidence 记录 main 的当前内容证据 → 将任务置于终态。\n'
    + '4. 到此为止。**Orbit 里没有任何东西会判定这些验收标准**：0229 移除了项目验收判定，'
    + 'run、逐条裁决、结论事件和 DONE 闸全部不存在了。把逐条核对的结论和证据写进 task_comment 交给账号所有者，'
    + '不要去找一个能提交裁决的工具——没有。\n'
    + '5. 你改不了验收标准：尺子归账号所有者通道。project_update 的 status 现在没有守卫，'
    + '这不是让你去写 DONE 的授权——写不写由账号所有者决定，你把证据交上去。\n\n'
    + '顺序再确认一次：合并到 main → project_merge_evidence → 在 task_comment 里逐条交证据；'
    + '缺主干时停在开任务/升级。'
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
    + '手上有哪些工具：读——project_get、task_list、task_get、session_list、session_get；'
    + '写——task_create、task_update、task_comment、task_start、project_update、project_merge_evidence。\n\n'
    + '写的时候有三条边界，服务端会照着拒（不是建议）：'
    + '① 普通新任务必须用 criterionKey 说明它服务于哪一条验收标准（project_get 里每条标准的 key），'
    + '并受这个项目每天能开多少个任务的预算限制；只有服务端已将本会话绑定到 ACTIVE canonical remediation '
    + 'obligation 时，该 revision 才能作为不伪造 criterionKey 的正交范围理由，并走独立容量上限；'
    + '② 验收标准你改不了——尺子归账号所有者通道；'
    + '③ 0229 移除了项目验收判定：没有任何东西会判定这些标准，也没有工具能提交裁决。'
    + 'project_update 的 status 已无守卫，但那不是让你写 DONE 的授权——把证据交给账号所有者。'
    + '这三条是判断会话的角色隔离和按动作留痕，不是对“真人在场”的密码学证明；'
    + '把发现和还差什么写进 task_comment，账号所有者会读到。\n\n'
    + '没给你的工具就别去找：列出或删除项目、直接指挥 runner，都不在你手上。'
    + (fact.event === 'PROJECT_TASKS_SETTLED' ? settledAcceptanceProtocol(projectId) : '')
    + '\n\n'
    + '同一个项目还有一条人点开的协调会话，长期开着、由人驱动。它和这次判断读库里同一份事实，不共享上下文；'
    + '这次判断不会动它，它也不会动这次判断。'
  );
}
