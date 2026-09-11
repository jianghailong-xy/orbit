import { uuidToBase62 } from '@orbit/shared';

import { SettledCriterionReport, WakeFact } from './coordinator-wake';

/**
 * What a coordinator is TOLD about a committed fact — in either of the two places one can be told.
 *
 * Two writers, one renderer. `buildJudgmentOpening` opens the one-shot conversation a fact wakes;
 * `buildCoordinatorDeliveryMessage` is the message the project's standing conversation is sent when
 * the fact is delivered to it instead (`coordinator-delivery.service.ts`). They differ in what the
 * reader already knows and in nothing else, so `describeWakeFact` renders the fact for both — one
 * event never gets two descriptions.
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
    case 'PROJECT_ACCEPTANCE_LANDED':
      return (
        `这个项目下的 ${String(detail.taskCount ?? '全部')} 个任务都到了终态，`
        + `而且它声明的 ${settledCriteriaOf(fact).length} 条验收标准每一条都已满足、`
        + '并且有合并回执证明成果在默认分支上。'
      );
    case 'CRITERION_READY':
      return (
        `服务验收标准 ${String(detail.criterionKey ?? fact.subjectId)} 的 ` +
        `${String(detail.taskCount ?? '全部')} 个任务都 DONE 了。`
      );
    case 'CRITERION_UNLANDED':
      return (
        `服务验收标准 ${String(detail.criterionKey ?? fact.subjectId)} 的 ` +
        `${String(detail.taskCount ?? '全部')} 个任务都 DONE 了，但没有任何合并回执能证明这些成果` +
        `已经在默认分支上（落地判定：${String(detail.landing ?? '未知')}）。`
      );
    case 'COMPLETION_EVIDENCE_REVISED':
      return (
        `任务 ${uuidToBase62(fact.subjectId)} 提交了第 ${String(detail.evidenceRevision ?? '未知')} `
        + '版完成证据。'
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
    case 'CRITERIA_DECISION_PENDING':
      return (
        '这个项目收到了一次会放松验收标准的编辑。它没有生效——在册的标准一个字都没动——'
        + `而是被扣成了一条待决提案（提案 ${String(detail.intentId ?? fact.subjectId)}，`
        + `内容摘要 ${String(detail.actionDigest ?? '未知').slice(0, 16)}…），等账号所有者决定。`
      );
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
    + '5. 你改不了验收标准：尺子归账号所有者通道。project_update 的 status 你也写不了，'
    + '服务端会按 PROJECT_STATUS_NOT_SESSION_WRITABLE 拒掉整个请求——写不写由账号所有者决定，'
    + '你把证据交上去。\n\n'
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
    + 'project_update 的 status 你也写不了：带会话的请求写这个字段会被整条拒掉'
    + '（PROJECT_STATUS_NOT_SESSION_WRITABLE），DONE 由账号所有者决定，你把证据交上去。'
    + '这三条是判断会话的角色隔离和按动作留痕，不是对“真人在场”的密码学证明；'
    + '把发现和还差什么写进 task_comment，账号所有者会读到。\n\n'
    + '没给你的工具就别去找：列出或删除项目、直接指挥 runner，都不在你手上。'
    + (fact.event === 'PROJECT_TASKS_SETTLED' ? settledAcceptanceProtocol(projectId) : '')
    + '\n\n'
    + '同一个项目还有一条人点开的协调会话，长期开着、由人驱动。它和这次判断读库里同一份事实，不共享上下文；'
    + '这次判断不会动它，它也不会动这次判断。'
  );
}

/** The roster the two project-scoped facts carry, read out of `detail` and trusted for nothing else. */
function settledCriteriaOf(fact: WakeFact): SettledCriterionReport[] {
  const criteria = (fact.detail ?? {}).criteria;
  return Array.isArray(criteria) ? criteria as SettledCriterionReport[] : [];
}

/** One line per criterion, then one per criterion for the work that served it. */
function renderSettledCriteria(criteria: readonly SettledCriterionReport[]): string {
  return criteria
    .map((criterion, index) => {
      const serving = criterion.serving
        .map((task) => `${task.title}（${uuidToBase62(task.taskId)}，${task.status}）`)
        .join('、');
      return (
        `${index + 1}. ${criterion.text}\n`
        + `   满足：${criterion.satisfied ? '是' : '否'}；落地：${criterion.landing}；`
        + `服务它的任务：${serving || '无'}`
      );
    })
    .join('\n');
}

/**
 * The message the project's STANDING coordinator conversation is sent.
 *
 * WHY THIS IS NOT `buildJudgmentOpening`
 * ======================================
 * That one opens a conversation, and everything it says is calibrated for a reader with no
 * context: who it is, what it may not do, where every read lives, that nobody will answer it. This
 * reader has all of that already — it is the conversation a person opened to drive this project,
 * it has been reading these same tables for however long it has been running, and it was told the
 * rules on its own first turn. Repeating them would spend the one resource this carrier is chosen
 * to save.
 *
 * WHAT IT SAYS INSTEAD, AND WHY EACH LINE EARNS ITS PLACE
 * ======================================================
 * A coordinator conversation measured on 2026-09-06 was 365 turns and 481k of a 1000k context
 * window, so a message here is charged to every turn that comes after it, for the rest of that
 * conversation's life. Four lines survive that test:
 *
 *   1. the fact, rendered by `describeWakeFact` and from nothing else — the same renderer the
 *      judgment opening uses, so one event never gets two descriptions;
 *   2. the merge order, which is a hard constraint rather than advice and is the whole reason this
 *      fact is worth interrupting anybody about. It is `settledAcceptanceProtocol`'s order, said in
 *      one line rather than five: the reader already knows the tools;
 *   3. where to read the rest, because nothing else about the project is copied in here — the
 *      state is in the database, and this message is not a snapshot of it;
 *   4. that this is a NOTIFICATION. Claude does not steer mid-turn, so a conversation that was
 *      running when this arrived reads it afterwards, by which time its own reads are newer than
 *      anything this message could have carried. A reader that assumed otherwise would act on a
 *      world that has moved.
 *
 * AND WHY THE SECOND LINE IS NOT THE SAME FOR EVERY FACT
 * ======================================================
 * Lines 1, 3 and 4 are properties of the carrier and are the same for every fact delivered here.
 * Line 2 is not: it is the ACTION, and the merge order above is the action `CRITERION_UNLANDED`
 * calls for. The one other fact delivered here calls for a different one.
 *
 * AND WHY THAT ONE CARRIES A SNAPSHOT THE MERGE CARD REFUSES TO
 * =============================================================
 * `PROJECT_ACCEPTANCE_LANDED` — every task terminal and every stated criterion satisfied AND on
 * the default branch — is the one message here that copies project state into itself: every
 * criterion's words, its two dimensions, and the work that served it. Line 3's rule is not being
 * broken so much as met head on — the question this card asks is "do THESE N conditions, together,
 * express the goal", and a question about a set that does not carry the set is one its reader
 * cannot answer without going to fetch what it is being asked about. So the roster is in the card
 * and the card says out loud
 * that it is the snapshot at the moment the fact became true; everything else is still a read.
 *
 * What it must NOT do is answer. `CONFIRM_ACCEPTANCE_CRITERIA` is HUMAN_ONLY
 * (`coordinator-authority.ts`), so the action line here is to put the list in front of the account
 * owner rather than to conclude anything from it — and in particular not to write `project.status`,
 * which this card cannot write and nobody writes by hand any more. r2's `refuseProjectStatusWrite`
 * refuses the whole request when it carries an acting session, which every delivery of this card
 * does; and `project-done-derived.ts` projects `DONE` from criteria that are satisfied and landed
 * onto the owner's confirmation of the standard set as it stands. So the line about `status` names
 * the refusal and the projection rather than an absence of a guard: a reader told the field is
 * merely unauthorized spends a turn on a 403, and one told a person writes it goes looking for a
 * writer that does not exist.
 *
 * WHAT IS NOT DELIVERED HERE ANY MORE
 * ===================================
 * Until 2026-09-10 two more facts had a branch here: `COMPLETION_EVIDENCE_REVISED`, whose message
 * told the turn to ask the account owner through `AskUserQuestion`, and
 * `CRITERIA_DECISION_PENDING`, whose message relayed a held loosening's diff. Both were questions
 * only the account owner may answer, so the turn that carried them could only pass them on. Both
 * are now cards the clients draw from the pending reads, with buttons that reach the decision doors
 * directly, and neither fact is delivered to any conversation.
 */
export function buildCoordinatorDeliveryMessage(fact: WakeFact, projectTitle: string): string {
  const projectId = uuidToBase62(fact.projectId);
  if (fact.event === 'PROJECT_ACCEPTANCE_LANDED') {
    const criteria = settledCriteriaOf(fact);
    return (
      `【项目「${projectTitle}」的验收标准已全部满足并落地，请确认它们表达的是你要的目标】\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + `这 ${criteria.length} 条标准，每一条都已满足、且有合并回执证明成果在默认分支上：\n`
      + `${renderSettledCriteria(criteria)}\n\n`
      + `要回答的不是「这些标准满足了吗」——上面那份清单已经是这个问题的答案。要回答的是 `
      + `CONFIRM_ACCEPTANCE_CRITERIA 那一句：这 ${criteria.length} 条合起来，表达的是当初要的那个目标吗？\n\n`
      + '这一句你答不了，它是 HUMAN_ONLY：确认只走账号所有者认证的通道，任何带 acting session 的调用'
      + '都会被服务端拒掉。确认卡由 Orbit 直接画在这个会话里——网页、iOS、macOS 上都是同一张卡，'
      + '卡上能展开读到这份清单，按钮带着账号所有者自己的凭据直达确认的门，不经过你。'
      + '你要做的是把上面这份清单交给账号所有者，请账号所有者在这个会话里的那张确认卡上确认；'
      + '确认会绑定当前这一版标准，之后任何一条标准被改动，那次确认就自动不算数了。\n\n'
      + 'project_update 的 status 你也写不了：带会话的请求写这个字段会被整条拒掉'
      + '（PROJECT_STATUS_NOT_SESSION_WRITABLE）。DONE 也不是谁写的一列——上面每条都满足、都 LANDED，'
      + '再加上账号所有者对这一版标准集的确认，服务端自己把它投影出来。\n\n'
      + `全量状态自己读，上面那份清单是事实成立那一刻的快照：project_get（projectId 传 ${projectId}）`
      + `读目标与验收标准，task_list（projectId 传 ${projectId}）读每个任务的状态与依赖。\n\n`
      + '这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，'
      + '所以以你自己刚读到的库里状态为准。'
    );
  }
  return (
    `【项目「${projectTitle}」有干完但还没落 main 的成果】\n\n`
    + `${describeWakeFact(fact)}\n\n`
    + '合并的顺序是硬约束，不是建议：合并到 main → 用 project_merge_evidence 记录 main 的当前内容证据 '
    + '→ 再把对应任务置终态。合并失败就停下来把原因写进 task_comment，不要反复重试。\n\n'
    + `全量状态自己读，这条消息里除了上面那个事实没有这个项目的任何其他状态：project_get（projectId 传 `
    + `${projectId}）读目标与验收标准，task_list（projectId 传 ${projectId}）读每个任务的状态与依赖。\n\n`
    + '这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，'
    + '所以以你自己刚读到的库里状态为准。'
  );
}
