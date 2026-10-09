import { uuidToBase62 } from '@orbit/shared';

import { dispatchRefusalNextStep } from '../tasks/task-dispatch-refusal';
import { SettledCriterionReport, WakeFact } from './coordinator-wake';
import type { CriterionLandingReason } from './criterion-landing-reason';
import { criterionKeyOf } from './project-acceptance';
import type { DerivedProjectDoneReading } from './project-done-derived';

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
 * answer it: with the project's Automatic switch off it says "推进靠的是跟人对话" and
 * "没有任何自动的环会替你决定什么时候动". Both are true there and false here. This session was
 * decided on by something automatic — a fact `CoordinatorWakeService` claimed — and there is
 * nobody on the other end of it. Reusing that opening would open every judgment by telling it two
 * things that are not so, which is the mistake 60dece5e removed from the OLD opening (it described
 * a §9.2 policy matrix no code enforced any more) and worth not making a second time.
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
    case 'PROJECT_BLOCKER_RAISED': {
      const paths = Array.isArray(detail.paths)
        ? detail.paths.filter((path): path is string => typeof path === 'string')
        : [];
      const pathText = paths.length > 0 ? `，涉及 ${paths.join('、')}` : '';
      return (
        `任务「${String(detail.taskTitle ?? uuidToBase62(fact.subjectId))}」触发了 `
        + `project blocker ${String(detail.blockerKind ?? 'UNKNOWN')}${pathText}，需要账号所有者裁决。`
      );
    }
    case 'COMPLETION_EVIDENCE_REVISED':
      // The title is there when the fact is delivered to be decided (`CompletionEvidenceProducer`);
      // a fact that was only recorded carries the id alone. A revision a confirmed move handed over
      // names the project it came from (`completionEvidenceRevisedFact`'s `movedFromProjectId`).
      return (
        (typeof detail.title === 'string'
          ? `任务「${detail.title}」（${uuidToBase62(fact.subjectId)}）`
          : `任务 ${uuidToBase62(fact.subjectId)} `)
        + (typeof detail.movedFromProjectId === 'string'
          ? `带着还没判定的第 ${String(detail.evidenceRevision ?? '未知')} 版完成证据，经账号所有者确认`
            + `从项目 ${uuidToBase62(detail.movedFromProjectId)} 移进了这个项目：这一版现在由这个项目判，`
            + '原项目不能再判它。'
          : `提交了第 ${String(detail.evidenceRevision ?? '未知')} 版完成证据。`)
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
    case 'TASK_DISPATCH_REFUSED': {
      const base = typeof detail.baseSha === 'string' ? detail.baseSha : null;
      const missing = Array.isArray(detail.missing)
        ? (detail.missing as Array<{ sha?: unknown; taskId?: unknown }>)
        : [];
      const named = missing.map((commit) => (
        typeof commit.taskId === 'string'
          ? `前置 ${uuidToBase62(commit.taskId)} 落地的 ${String(commit.sha).slice(0, 10)}`
          : `提交 ${String(commit.sha).slice(0, 10)}`
      ));
      return (
        `任务 ${uuidToBase62(fact.subjectId)}「${String(detail.taskTitle ?? '')}」的一次开工在起跑前被 `
        + `runner 拒绝了：${String(detail.code ?? '未知')}。`
        + (base ? `它钉在 ${base.slice(0, 10)}` : '')
        + (base && named.length > 0 ? `，这个提交不包含${named.join('、')}` : '')
        + (base ? '。' : '')
        + '这次开工没有变成一次运行：没有启动引擎，任务状态没有被改动。'
      );
    }
    case 'DEPENDENT_READY':
      return (
        `任务「${String(detail.title ?? '')}」（${uuidToBase62(fact.subjectId)}）现在可以开工了：`
        + '它的前置都已完成并落地到这个项目的集成线（或本来就没有要落地的代码）。'
        + '但它设了 autoRunWhenReady=false，平台不会自己开它——没人开工，它就一直停在这里。'
      );
    case 'PROJECT_SETTLED_UNMERGED': {
      const commits = unmergedCommitsOf(fact);
      const short = commits.map((sha) => sha.slice(0, 10));
      return (
        `这个项目已经结算（DONE），但它的集成线上还有 ${String(detail.taskCount ?? '一些')} 件`
        + `成果没有合并回默认分支：${short.length > 0 ? short.join('、') : '（提交列表见下）'}。`
        + '这些提交所在的落地作业在会话写下最后一个提交之前就已经终态，所以没有任何晋升候选'
        + '点名过它们——结算之后也不会再有写入来重新发现。'
      );
    }
    default:
      return `发生了 ${fact.event}，主体是 ${fact.subjectType} ${fact.subjectId}。`;
  }
}

/** The commits a `PROJECT_SETTLED_UNMERGED` fact names, in the order its `detail` carries them. */
function unmergedCommitsOf(fact: WakeFact): string[] {
  const detail = (fact.detail ?? {}) as Record<string, unknown>;
  return Array.isArray(detail.commits) ? detail.commits.map((sha) => String(sha)) : [];
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
 *
 * It no longer tells the session to file a "merge into main" task (project closing, D5). On
 * 2026-10-01 it did, in the gap between the work landing on the project branch and that branch
 * reaching main, and the task it filed was hung on a criterion that was already met. Getting work
 * into main is the platform's landing jobs and the standing coordinator's, such a task serves no
 * criterion, and a judgment may only open work that names one — so it opens none. A settled
 * project's judgment is not even opened while a landing is in flight
 * (`project-tasks-settled.producer.ts` §4), and the server refuses its `task_create` if one starts
 * after it was (`TASK_LANDING_IN_FLIGHT`).
 */
export function settledAcceptanceProtocol(projectId: string): string {
  return (
    '\n\n这条 PROJECT_TASKS_SETTLED 事实要核对主干证据；按下面的顺序行动，顺序是硬约束，不是建议：\n'
    + `1. 先用 project_get（projectId 传 ${projectId}）读取这个项目声明的验收标准，`
    + '以及 derivedDone 里每条标准的 landingReason。\n'
    + '2. 确认实现已经真正落到 main，并且 main 上的行为满足验收对象。任务标成 DONE 只说明某个工作分支做完了，'
    + '不证明 main 已包含它。成果还不在 main 上时，先看是不是平台正在落地：landingReason 是 IN_FLIGHT，'
    + '或者项目有 LAND_TASK、CHECK_PROMOTION、LAND_PROMOTION 排队或在跑——那就什么都不开，结束本轮，'
    + '作业结束后平台会重新推算（这时服务端也会拒掉你的 task_create：TASK_LANDING_IN_FLIGHT）。\n'
    + '3. 不开“合进 main”的任务：把成果送进 main 是平台的落地作业和项目协调会话的事，这类任务不服务任何验收标准，'
    + '不得带 criterionKey，而判断会话开的任务必须带 criterionKey——所以这类任务一个都不开。'
    + '没在途、又确实不在 main 上的成果（landingReason 是 ON_PROJECT_BRANCH、NO_RECEIPT、NOTHING_TO_LAND 或 CODELESS），'
    + '把逐条核对的结论写进相关任务的 task_comment 中升级给人，然后结束本轮。'
    + '只有某条验收标准真的还缺活——不是缺合并——才用 task_create 开普通任务，带上它服务的那条 criterionKey。\n'
    + '4. 你核实成果已经合到 main 时，证据的顺序必须是：合并到 main → 用 project_merge_evidence 记录 main 的当前内容证据。\n'
    + '5. 到此为止。**Orbit 里没有任何东西会判定这些验收标准**：0229 移除了项目验收判定，'
    + 'run、逐条裁决、结论事件和 DONE 闸全部不存在了。把逐条核对的结论和证据写进 task_comment 交给账号所有者，'
    + '不要去找一个能提交裁决的工具——没有。\n'
    + '6. 你改不了验收标准：尺子归账号所有者通道。project_update 的 status 你也写不了，'
    + '服务端会按 PROJECT_STATUS_NOT_SESSION_WRITABLE 拒掉整个请求——写不写由账号所有者决定，'
    + '你把证据交上去。\n\n'
    + '顺序再确认一次：落地在途就结束本轮 → 不开“合进 main”的任务 → 合并到 main → project_merge_evidence '
    + '→ 在 task_comment 里逐条交证据。'
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

/**
 * One line per criterion the projection is holding back: the clauses it trips, then the
 * satisfaction lane's unmet codes, named by the words the roster carries for it when it has them.
 */
function renderWithheldCriteria(fact: WakeFact, reading: DerivedProjectDoneReading): string {
  const texts = new Map(settledCriteriaOf(fact).map((criterion) => [criterion.key, criterion.text]));
  const unmet = new Map(reading.satisfaction.map((row) => [
    row.definitionId, row.unmet.map((reason) => reason.clause),
  ]));
  return reading.derived.criteria
    .filter((criterion) => criterion.withheld.length > 0)
    .map((criterion) => {
      const key = criterionKeyOf(criterion.definitionId);
      const text = texts.get(key);
      const codes = unmet.get(criterion.definitionId) ?? [];
      return (
        `- ${text ? `「${text}」（key ${key}）` : `key ${key}`}：${criterion.withheld.join('、')}`
        + `；unmet：${codes.length > 0 ? codes.join('、') : '无'}`
      );
    })
    .join('\n');
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
 * calls for. The one other fact delivered here calls for a different one — and so does
 * `TASK_DISPATCH_REFUSED`, whose action is the refusal's own next step, the sentence the task's
 * comment gives (`dispatchRefusalNextStep`), so the two cannot advise differently.
 *
 * `DEPENDENT_READY`'s action is a decision rather than an order: whether to `task_start` a task
 * that can now start and will not start by itself. The line names the task and the two calls, and
 * says the one thing the reader cannot find out for itself — that nobody else is going to start
 * it — without saying what to conclude.
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
 * AND WHEN THE OWNER HAS ALREADY CONFIRMED, THERE IS NOTHING TO ASK
 * ================================================================
 * The confirmation can be on record, naming the version that stands, before the last receipt
 * lands. Then that receipt is the last input the projection needed: the project goes DONE on the
 * same edge that sends this message, and no client draws a card, because
 * `settlementHeldOnConfirmation` holds one only for an OPEN project whose standing can still be
 * answered. On 2026-09-25 (project 34JNIW4b31ujSVqEG784v) the message asked anyway, and a
 * coordinator doing what it said would have sent the owner looking for a card that was not there.
 *
 * So `reading` — the projection and the standing it was folded from, read by the delivery as it
 * writes these words — decides the text, and a confirmation is not taken for DONE. The fact is
 * derived from the serving tasks' STATUSES; the projection also asks whether each settled by its
 * own declared criterion, on the revision of the criterion that stands, and by a session that did
 * not write that criterion. So:
 *
 *   * DONE — says when the owner confirmed and that nothing is left to do, and carries no roster:
 *     the roster is in the card for the question, and there is no question;
 *   * CONFIRMED and still held back — says the confirmation is not what is missing, names what is
 *     (`withheld`, and each held criterion's clauses and unmet codes), and where to read the rest.
 *     It says neither DONE, which it is not, nor "confirm", which is done;
 *   * not confirmed, or confirmed about criteria that have since been edited — reads exactly as it
 *     always has.
 *
 * WHAT IS NOT DELIVERED HERE ANY MORE
 * ===================================
 * Until 2026-09-10 two more facts had a branch here: `COMPLETION_EVIDENCE_REVISED`, whose message
 * told the turn to ask the account owner through `AskUserQuestion`, and
 * `CRITERIA_DECISION_PENDING`, whose message relayed a held loosening's diff. Both were treated as
 * questions only the account owner may answer, so the turn that carried them could only pass them
 * on. Both became cards the clients draw from the pending reads, with buttons that reach the
 * decision doors directly. The held loosening is still delivered to nobody.
 *
 * AND WHAT CAME BACK, AS SOMETHING ELSE (2026-09-29)
 * ==================================================
 * `COMPLETION_EVIDENCE_REVISED` has a branch again, in an Automatic project only, and it is not a
 * relay: deciding evidence is COORDINATOR_BOUNDED (`coordinator-authority.ts`), so the message
 * asks this conversation to read the evidence and decide it itself — CONFIRM, or SEND_BACK with a
 * note saying what the next revision must show — and says the one thing it cannot see from where
 * it sits: that the owner's card is held back only for the project's `exceptionEscalationSeconds`,
 * after which the owner is asked. The criterion the evidence quotes is copied in, as its own
 * words: it is the standard the decision binds to, and the reader has no other place to find the
 * version this revision was measured against.
 *
 * AND A PROJECT THAT LOOKS FINISHED (2026-10-01)
 * ==============================================
 * `PROJECT_TASKS_SETTLED` is delivered here too, in one case only: every criterion met, nothing
 * running, open or landing, and the projection still withholding DONE (`project-looks-finished.ts`).
 * It is the one other message that copies project state in — each criterion Orbit cannot prove, by
 * its words and its landing reason, and the projection's counts — for the card's reason: what it
 * asks is a choice about those criteria. The choice is the coordinator's to make and the record is
 * the owner's: request done (`project_request_done`) or go and do the work, and if neither, the owner
 * is asked once the project's `exceptionEscalationSeconds` have run out (`buildLooksFinishedMessage`).
 */
export function buildCoordinatorDeliveryMessage(
  fact: WakeFact,
  projectTitle: string,
  /** The projection and the standing it was folded from. Only `PROJECT_ACCEPTANCE_LANDED` and
   *  `PROJECT_TASKS_SETTLED` read it, and absent reads as not confirmed. */
  reading?: DerivedProjectDoneReading | null,
  /** The project's `exceptionEscalationSeconds`, which `PROJECT_TASKS_SETTLED` quotes. */
  options: { escalationSeconds?: number } = {},
): string {
  const projectId = uuidToBase62(fact.projectId);
  if (fact.event === 'PROJECT_TASKS_SETTLED' && reading) {
    return buildLooksFinishedMessage(fact, projectTitle, reading, options.escalationSeconds);
  }
  if (fact.event === 'PROJECT_ACCEPTANCE_LANDED') {
    const standing = reading?.standing;
    const confirmedAt = standing?.confirmed ? standing.confirmation?.confirmedAt : undefined;
    if (reading && confirmedAt && !reading.derived.done) {
      const held = renderWithheldCriteria(fact, reading);
      return (
        `【项目「${projectTitle}」的验收标准都已落地，这一版也已确认，但项目还没有投影成 DONE】\n\n`
        + `${describeWakeFact(fact)}\n\n`
        + `现在这一版标准集，就是账号所有者 ${confirmedAt.toISOString()} 确认过的那一版`
        + '（CONFIRM_ACCEPTANCE_CRITERIA）：确认不缺，这里没有要确认的东西，这个会话里也不会出现确认卡。\n\n'
        + `但项目还没有投影成 DONE，扣住它的是 ${reading.derived.withheld.join('、')}。`
        + '上面那句「每一条都已满足」只看服务任务的状态；投影还要看每个任务按它自己声明的完成条件是否算完成、'
        + '声明的是不是这条标准现在的版本，以及写这条标准的会话是否也在产出它的证据。'
        + (held ? `被扣住的标准：\n${held}` : '')
        + '\n\n'
        + `还缺什么、卡在哪个任务上，自己读：project_get（projectId 传 ${projectId}）返回的 derivedDone `
        + '给出 withheld 和每条标准的答案，每条验收标准上的 unmet 给出每个 unmet 码和卡住它的任务；'
        + `task_list（projectId 传 ${projectId}）读每个任务的状态与依赖。\n\n`
        + 'DONE 不是谁写的一列：缺的补上之后，服务端自己把它投影出来。project_update 的 status 你也写不了：'
        + '带会话的请求写这个字段会被整条拒掉（PROJECT_STATUS_NOT_SESSION_WRITABLE）。\n\n'
        + '这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，'
        + '所以以你自己刚读到的库里状态为准。'
      );
    }
    // Confirmed, and the projection agrees: DONE.
    if (confirmedAt) {
      return (
        `【项目「${projectTitle}」的验收标准已全部满足并落地，已按账号所有者的确认记为 DONE】\n\n`
        + `${describeWakeFact(fact)}\n\n`
        + `现在这一版标准集，就是账号所有者 ${confirmedAt.toISOString()} 确认过的那一版`
        + '（CONFIRM_ACCEPTANCE_CRITERIA）。项目已按那次确认记为 DONE，无需任何动作：这里没有要确认的东西，'
        + '这个会话里也不会出现确认卡——确认卡只为还没被确认的那一版画出来。\n\n'
        + 'DONE 不是谁写的一列：每条标准都满足、都 LANDED，再加上账号所有者对这一版标准集的确认，'
        + '服务端自己把它投影出来。project_update 的 status 你也写不了：带会话的请求写这个字段会被整条拒掉'
        + '（PROJECT_STATUS_NOT_SESSION_WRITABLE）。\n\n'
        + '全量状态自己读，这条消息里除了上面那个事实和那次确认的时间，没有这个项目的任何其他状态：'
        + `project_get（projectId 传 ${projectId}）读目标、验收标准与 status，`
        + `task_list（projectId 传 ${projectId}）读每个任务的状态与依赖。\n\n`
        + '这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，'
        + '所以以你自己刚读到的库里状态为准。'
      );
    }
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
  if (fact.event === 'TASK_DISPATCH_REFUSED') {
    const detail = (fact.detail ?? {}) as { fixAction?: string; ref?: string | null };
    const taskId = uuidToBase62(fact.subjectId);
    return (
      `【项目「${projectTitle}」有一个任务开不了工】\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + `下一步：${dispatchRefusalNextStep({
        fixAction: detail.fixAction ?? '未记录', ref: detail.ref ?? null,
      })}\n\n`
      + `这次拒绝记在任务上：task_get（taskId 传 ${taskId}）的 dispatchRefusal 是码、fixAction、时间、哪次`
      + '运行、起跑用的 ref、它钉住的提交（解析期就被拒的没有）和缺的提交，任务评论里有 runner 的原话。'
      + '任务再开工之后这一栏会清空；再被拒会重新记一次、再通知你一次。\n\n'
      + `全量状态自己读，这条消息里除了上面那个事实没有这个项目的任何其他状态：project_get（projectId 传 `
      + `${projectId}）读目标与验收标准，task_list（projectId 传 ${projectId}）读每个任务的状态与依赖。\n\n`
      + '这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，'
      + '所以以你自己刚读到的库里状态为准。'
    );
  }
  if (fact.event === 'PROJECT_BLOCKER_RAISED') {
    const detail = (fact.detail ?? {}) as {
      blockerId?: unknown;
      blockerKind?: unknown;
      requiredAction?: unknown;
      taskTitle?: unknown;
      agentArgument?: unknown;
      criterionText?: unknown;
      paths?: unknown;
    };
    const taskId = uuidToBase62(fact.subjectId);
    const blockerId = typeof detail.blockerId === 'string'
      ? uuidToBase62(detail.blockerId)
      : uuidToBase62(fact.subjectVersion);
    const paths = Array.isArray(detail.paths)
      ? detail.paths.filter((path): path is string => typeof path === 'string')
      : [];
    const evidence = typeof detail.agentArgument === 'string' && detail.agentArgument.trim()
      ? `agent 的原话：\n「${detail.agentArgument.trim()}」\n\n`
      : '';
    const criterion = typeof detail.criterionText === 'string' && detail.criterionText.trim()
      ? `当前判据：\n「${detail.criterionText.trim()}」\n\n`
      : '';
    const files = paths.length > 0 ? `涉及文件：\n${paths.map((path) => `- ${path}`).join('\n')}\n\n` : '';
    return (
      `【项目「${projectTitle}」有一条交付需要账号所有者裁决】\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + `${evidence}${criterion}${files}`
      + `这不是普通失败，也不是你可以自行放行的合并。先用 project_get（projectId 传 ${projectId}）和 `
      + `task_get（taskId 传 ${taskId}）核对上下文；在裁决前不要合并，也不要放行下一条任务。\n\n`
      + `如果你能把建议和依据写清楚，用 project_blocker_resolve（projectId 传 ${projectId}，`
      + `blockerId 传 ${blockerId}，reason 说明你建议如何处理）提交建议。这个动作会先进入账号所有者的确认卡，`
      + '只有账号所有者同意后 blocker 才会关闭；对方拒绝或卡片无人回答时，保持 blocker 打开并继续报告它。\n\n'
      + `平台要求的原动作：${String(detail.requiredAction ?? '先得到账号所有者的决定。')}\n\n`
      + '这是一条通知，不会中断当前回合；以你重新读取到的项目状态为准。'
    );
  }
  if (fact.event === 'COMPLETION_EVIDENCE_REVISED') {
    const detail = (fact.detail ?? {}) as {
      evidenceRevision?: unknown;
      criterion?: { key?: unknown; text?: unknown } | null;
      escalationSeconds?: unknown;
    };
    const taskId = uuidToBase62(fact.subjectId);
    const revision = String(detail.evidenceRevision ?? '');
    const criterion = detail.criterion && typeof detail.criterion.text === 'string'
      ? detail.criterion
      : null;
    const escalation = typeof detail.escalationSeconds === 'number'
      ? `（现在是 ${detail.escalationSeconds} 秒）`
      : '';
    return (
      `【项目「${projectTitle}」有一版完成证据等你判】\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + (criterion
        ? `这版证据引用的判据（key ${String(criterion.key)}），原文：\n「${String(criterion.text)}」\n\n`
        : '')
      + '这个项目开着 Automatic：任务做没做完由你按证据判，不先交给账号所有者。'
      + `先用 task_evidence_list（taskId 传 ${taskId}）读第 ${revision} 版证据——它声称做成了什么`
      + '（claim）、引用了哪些检查（checks）、自己承认没证明什么（gaps）；需要时用 task_get '
      + `（taskId 传 ${taskId}）看任务描述和评论。然后用 task_evidence_decide（taskId 传 ${taskId}，`
      + `evidenceRevision 传 "${revision}"）判：证据足以证明上面那条判据，判 CONFIRM，任务随之 DONE；`
      + '不足，判 SEND_BACK，note 里写清下一版证据要证明什么——note 会作为平台消息直接投给提交这版的执行会话，'
      + '它改完交下一版；任务保持 OPEN。\n\n'
      + `你不判的话，投递之后过了这个项目的 exceptionEscalationSeconds${escalation}，这一版会交给`
      + '账号所有者在 app 里判；账号所有者任何时候也都可以直接判。真正要账号所有者拍板的题另用 '
      + 'ask_owner 问（每题带推荐默认）；「想让账号所有者看一眼」不是不判的理由。\n\n'
      + `全量状态自己读，这条消息里除了上面那个事实和它引用的判据原文，没有这个项目的任何其他状态：`
      + `project_get（projectId 传 ${projectId}）读目标与验收标准，task_list（projectId 传 `
      + `${projectId}）读每个任务的状态与依赖。\n\n`
      + '这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，'
      + '所以以你自己刚读到的库里状态为准——这一版可能已经被判过，或者已经有了更新的一版。'
    );
  }
  if (fact.event === 'DEPENDENT_READY') {
    const taskId = uuidToBase62(fact.subjectId);
    return (
      `【项目「${projectTitle}」有一条下游任务可以开工了】\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + '开不开工是你的判断，平台不会替你开：先用 task_get（taskId 传 '
      + `${taskId}）看它的描述、依赖和评论，确认前置落地的成果就是它要的基线；决定开工就 task_start`
      + `（taskId 传 ${taskId}）。决定先不开也可以，但这条消息同一代只会来一次，`
      + '不开工它就一直停在这里。\n\n'
      + `全量状态自己读，这条消息里除了上面那个事实没有这个项目的任何其他状态：project_get（projectId 传 `
      + `${projectId}）读目标与作业指导，task_list（projectId 传 ${projectId}）读每个任务的状态与依赖。\n\n`
      + '这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，'
      + '所以以你自己刚读到的库里状态为准——它可能已经被开工了。'
    );
  }
  if (fact.event === 'PROJECT_SETTLED_UNMERGED') {
    const commits = unmergedCommitsOf(fact);
    return (
      `【项目「${projectTitle}」结算了，还有成果停在集成线上没进 main】\n\n`
      + `${describeWakeFact(fact)}\n\n`
      + (commits.length > 0
        ? `要落地的提交：${commits.map((sha) => `\`${sha}\``).join('、')}\n\n`
        : '')
      + '平台没有替它们排晋升候选，也不会再排：候选是在一次次落地之后排的，而承载这些提交的落地作业'
      + '在提交写出来之前就已经终态。所以没有人在等它们，也没有别的东西会重新发现它们。\n\n'
      + '要做的只有一件事：把这些提交送进 main。走哪条路是你的判断——整条项目分支都该合的话，'
      + '合并卡是账号所有者的（本项目页面上的 Merge 卡，你替不了他点）；只该合这一部分、'
      + '或者要按任务分别落地的话，把成果合进 main 之后用合并回执记下来（merge_receipt），'
      + '回执才是「已经在 main 上」的证据。无论走哪条，先 project_get 读目标、'
      + 'task_list 读每个任务的状态，再自己看一眼那些提交，别只照着这条消息里的 sha 动手。\n\n'
      + `全量状态自己读，这条消息里除了上面那个事实没有这个项目的任何其他状态：project_get（projectId 传 `
      + `${projectId}）读目标与验收标准，task_list（projectId 传 ${projectId}）读每个任务的状态与依赖。\n\n`
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

/**
 * What each landing reason (`criterion-landing-reason.ts`) means, for a coordinator choosing between
 * asking for the project to be recorded done and going back to work. One sentence each, saying what
 * Orbit can and cannot see — never what to conclude.
 */
const LANDING_REASON_SENTENCES: Readonly<Record<CriterionLandingReason, string>> = {
  IN_FLIGHT: '平台正在落地它的成果，或正在把它合进 main',
  ON_PROJECT_BRANCH: '成果在项目分支上、有它自己的提交，但没有作业在把它合进 main',
  NOTHING_TO_LAND:
    '它的任务跑过分支，但落地作业判定分支上没有它自己的提交，Orbit 也证明不了分支尖端已经在 main 上'
    + '——没有可合的东西，就不会有回执',
  NO_RECEIPT: '没有任何回执证明它的成果在项目分支或 main 上：可能是在 Orbit 之外合进去的，也可能还没合',
  CODELESS: '它的任务没在 worktree 分支上干活，看起来不产出代码，又没声明 codeless——没有能落地的分支，就永远不会有回执',
};

/** The counts line, from the projection's own counts: the one place they are added up. */
function renderLandingCounts(reading: DerivedProjectDoneReading): string {
  const { counts } = reading.derived;
  const parts = [
    `${counts.criteria} 条验收标准`,
    `${counts.met} 条已满足`,
    `${counts.onMain} 条在 main 上`,
    ...(Object.entries(counts.byReason) as Array<[CriterionLandingReason, number]>)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${count} 条 ${reason}`),
  ];
  return parts.join(' · ');
}

/**
 * The message a project that LOOKS finished is delivered as: `PROJECT_TASKS_SETTLED`, sent to the
 * standing conversation instead of a judgment when every criterion is met, nothing is running or
 * queued, no item is open and nothing is landing — and the projection still withholds DONE
 * (`project-looks-finished.ts`, project closing D5).
 *
 * It names every criterion that is not on main by a receipt of its own, with the projection's
 * landing reason, because those are what Orbit cannot prove and what the coordinator has to account
 * for either way. Then it asks for one of two things — request done, or go and do the work — and
 * says what happens if it does neither: the project's `exceptionEscalationSeconds` later, the
 * account owner is shown "Record as done…". The roster is a snapshot, like the confirmation card's,
 * because the choice is about these criteria; everything else is still a read.
 */
function buildLooksFinishedMessage(
  fact: WakeFact,
  projectTitle: string,
  reading: DerivedProjectDoneReading,
  escalationSeconds: number | undefined,
): string {
  const projectId = uuidToBase62(fact.projectId);
  const texts = new Map(settledCriteriaOf(fact).map((criterion) => [criterion.key, criterion.text]));
  // The criteria holding DONE back: every one that is not LANDED, each with its reason. A LANDED one
  // with nothing to land is no gap, and shows only in the counts.
  const reasons = reading.derived.criteria
    .filter((criterion) => criterion.landing !== 'LANDED')
    .map((criterion) => {
      const key = criterionKeyOf(criterion.definitionId);
      const text = texts.get(key);
      const reason = criterion.landingReason ?? 'NO_RECEIPT';
      return (
        `- ${text ? `「${text}」（key ${key}）` : `key ${key}`}：${reason}——${LANDING_REASON_SENTENCES[reason]}`
      );
    })
    .join('\n');
  const window = escalationSeconds !== undefined ? `（现在是 ${escalationSeconds} 秒）` : '';
  return (
    `【项目「${projectTitle}」看起来做完了，但 Orbit 自己记不了 Done】\n\n`
    + `${describeWakeFact(fact)}\n\n`
    + 'Orbit 核对过的：每条验收标准都已被服务它的任务满足；没有在跑或排队的任务；没有未处理的待办；'
    + '没有在途的落地或合入 main 的作业（LAND_TASK、CHECK_PROMOTION、LAND_PROMOTION）。'
    + `但推算仍扣着 Done（${reading.derived.withheld.join('、')}）。`
    + '下面这些验收标准还没算落地，Orbit 证明不了它们的成果在 main 上，逐条原因：\n'
    + `${reasons}\n`
    + `（${renderLandingCounts(reading)}）\n\n`
    + '二选一，在这一轮里做：\n'
    + `1. 请求收尾：你核对过 main 和上线情况、认为目标已经达成，就调用 project_request_done（projectId 传 ${projectId}），`
    + '写一两句判断，并为上面每一条写一个缺口：criterionKey、Orbit 为什么证明不了、你核对过什么、证据在哪。'
    + 'Orbit 先做收尾检查，通过了才在这个会话里给账号所有者出「Is this project done?」卡；记 Done 是账号所有者的事。\n'
    + '2. 去干活：确实还有东西没做完、或没进 main，就去做。只为把成果送进 main 的任务不服务任何验收标准，'
    + '不要给它 criterionKey——挂到一条已满足的标准上，会让它重新变成未满足。'
    + '零提交的任务不要靠 merge_receipt 补回执：回执只记录真实发生过的合并。\n\n'
    + `两样都不做的话，从这条消息起过了这个项目的 exceptionEscalationSeconds${window}还没有收尾请求，`
    + '账号所有者的 Needs you 里会出现 Record as done…，由账号所有者自己决定。\n\n'
    + 'project_update 的 status 你写不了（PROJECT_STATUS_NOT_SESSION_WRITABLE）：Done 只由 Orbit 推算出来，'
    + '或由账号所有者自己记下。\n\n'
    + `全量状态自己读：project_get（projectId 传 ${projectId}）的 derivedDone 给出每条验收标准的 landingReason 和这些计数，`
    + `task_list（projectId 传 ${projectId}）读每个任务的状态与依赖。\n\n`
    + '这是一条通知，不是打断：你正在跑的那一轮不会被它中断，你是在那一轮结束之后才读到它的，'
    + '所以以你自己刚读到的库里状态为准。'
  );
}
