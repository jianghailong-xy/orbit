import { createHash } from 'node:crypto';
import { uuidToBase62 } from '@orbit/shared';

/** The title a coordination session is filed under. */
export function coordinatorSessionTitle(projectTitle: string): string {
  // "Coordinator" is a role, rendered as a badge; putting it in the mutable title duplicates
  // metadata and makes the project and its conversation acquire two different names. Both columns
  // are TEXT, so keep the identity exact rather than silently truncating one side.
  return projectTitle;
}

/**
 * The standing instructions for a project's coordination session.
 *
 * This is shared by all three places a coordinator can acquire its role: the opening message of a
 * newly-created coordinator, the `project_create` result that promotes the conversation already
 * in flight, and delivery-time context on its later messages. Keeping one instruction body is what
 * prevents those paths from granting the same database identity but describing different
 * behavioural boundaries.
 *
 * A coordinator is driven by user interaction. The control loop that used to open turns on its
 * own is gone, so this says what the project is, where to read its real state, and which tools are
 * in reach. It also says whether the project's Automatic switch (`coordinatorEnabled`) is on,
 * because the switch still acts: facts are delivered to this conversation as queued turns
 * (`CoordinatorDeliveryService`), auto-run tasks are started for it, and a clean promotion of the
 * project's own branch lands on main without the owner's card (`project-promotion.ts`). Saying
 * nothing about it was read as "the owner decides everything": the sentence about DONE, which
 * meant the project's, was generalised to its tasks, and the coordinator of an Automatic project
 * declared OWNER_CONFIRMED on a mock-up task and waited for the owner (seen 2026-09-29). So with
 * the switch on, the text divides the work — the platform judges EXECUTABLE and VERIFICATION, the
 * coordinator judges EVIDENCE_JUDGMENT, and the owner is needed only for the criteria, advance
 * authorization of launches and irreversible steps, and genuine trade-offs. With it off, the text
 * is the conversational one it was, and in both the DONE sentence names the project. The mode is
 * part of the rendered text and therefore of `buildCoordinatorDeliveryContextKey`, so flipping the
 * switch re-delivers the instructions on the next turn. The authenticated channel is useful
 * provenance, but is not by itself proof that a human rather than a credential holder is present.
 *
 * Unit T6 took two claims out of it. This used to say `project_update` was for the acceptance
 * criteria and for recording `status = DONE`, and both are routed to owner review: the criteria
 * are the exam this project is judged against, and DONE is the statement that its goal was met.
 * The owner-authenticated channel can still write either, while `coordinator-authority.ts`
 * restricts only the one-shot judgment session. That is workflow separation and action-specific
 * traceability, not a hard human-presence boundary, so the opening names both the route and its
 * actual guarantee.
 *
 * It also says what to do with the work a coordinator turns up: file it under this project, or —
 * when it is a body of work of its own — open a project for it. That second half used to be
 * forbidden here: the coordinator's half of the runner-side rule that stopped offering the
 * proposal to a session already inside recorded work (`orbitProjectInstructions`), which the
 * runner cannot apply to a coordinator because its claim carries no project pointer. The
 * boundary lives here, and it moved because what it guarded is handled at the write instead: a
 * session coordinates at most one project, so `createInSession` answers a second one by opening a
 * conversation of its own for it, which knows none of this one. The confirmation card is the
 * owner's answer, and the brief the coordinator writes is all that new conversation inherits —
 * which is what the body now says.
 *
 * It says the start is the owner's, because `task_start` is refused until they press it
 * (`projectAwaitingStart`): a coordinator told only at the refusal has already said it is starting.
 * And it says how to ask for it — `project_request_start`, once every criterion has a task serving
 * it — because the owner's "Start this project?" card appears only once the coordinator has asked.
 */
function renderCoordinatorInstructions(
  projectIdentity: string,
  coordinatorEnabled: boolean,
): string {
  return (
    `你是${projectIdentity}的协调会话。\n\n`
    + '这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。\n\n'
    + '先读再说：用 project_get 读这个项目的目标、验收标准和作业指导，再用 task_list（projectId 传上面那个 id）'
    + '看它下面的任务各自停在哪里。这两样都不在任务的描述里，不读就只能靠猜。读完先简短汇报现状。\n\n'
    + (coordinatorEnabled
      ? '这个项目开着 Automatic：账号所有者已经授权它自己往前走。勾了自动运行的任务由 Orbit 自己启动；'
        + '项目有自己的集成分支时，分支上检查全过、没有冲突的成果由平台自己合进 main；'
        + '任务上需要你处理的事会作为消息送到这条会话里。推进靠你自己判断，不靠一题一题去问账号所有者——'
        + '哪几类事才要找账号所有者，下面写着。\n\n'
      : '推进靠的是跟人对话：把现状说清楚，该问的问，商量下一步，然后动手。没有任何自动的环会替你决定什么时候动。\n\n')
    + '该动的时候你手上有工具：project_update 改这个项目的标题、目标、作业指导；'
    + 'task_create、task_update、task_start 管它下面的任务。\n\n'
    + '给你创建的每个任务填 modelHint（S/M/L/XL）和一句 modelHintReason，看到项目里缺建议的任务也用 task_update 补上。'
    + 'S：机械修改、改文案、升级版本（Sonnet · low）；M：需求清楚的功能或修复（Sonnet · medium）；'
    + 'L：根因不明、并发、跨模块、迁移、改派发等核心路径（Opus · high）；'
    + 'XL：架构设计、长时间无人值守、L 档反复失败（Opus · max）。'
    + 'Codex 引擎在同一个默认模型上对应 low/medium/high/xhigh。理由写判断依据，不超过 500 字。'
    + 'modelHint 是难度建议，失败后可以升档；model 是硬指定，优先于建议。引擎仍用 provider 字段指定。\n\n'
    + '项目开工之前 task_start 会被拒：任务可以先建好，别想办法绕开。开工由账号所有者来按，'
    + '由你来请求：计划写好、每条验收标准都有任务服务（task_create 带 criterionKey）之后，'
    + '用 project_request_start 请求启动，附上你建议的开工设置和一句理由。'
    + 'Orbit 先做 ready 检查，不通过会逐条说原因、什么都不记下；通过了才在账号所有者面前出启动卡。'
    + '等 Orbit 告诉你项目已开工再启动任务。\n\n'
    + '这条会话里冒出来的新工作，先看它是不是这个项目的一部分：是就记成这个项目下的任务；'
    + '真是一摊另外的事，可以开新项目——project_create 会先给屏幕这边的账号所有者弹一张确认卡，他点头才建。'
    + '开之前要知道：一个会话只能协调一个项目，所以新项目不会挂到这条会话上，服务器会在同一个 workspace 里'
    + '为它另开一条自己的协调会话，并把这件事写在结果里。那条会话对这里的来龙去脉一无所知，'
    + '你写下的目标、验收标准和作业指导就是它全部的前提——写得让它能自己站住，写不出来就先别开。\n\n'
    + '有两件事不是你来定：改这个项目的验收标准，和把这个项目记成 DONE。'
    + '验收标准是判定这个项目做没做完的那把尺子，改尺子的人可以让任何结论成立；'
    + '项目的 DONE 是「目标达成了」这句话本身，说错了没有下游会再问一遍。'
    + '这两件都由账号所有者通道记录——你把该改什么、还差什么说清楚，让屏幕这边的账号所有者决定。'
    + '这里的 HUMAN_ONLY 是角色隔离和按动作留痕，不是服务器对“真人在场”的密码学证明。'
    + '这里说的 DONE 是项目本身的，不是它下面某个任务的：任务做没做完，按各自声明的完成判据走。\n\n'
    + (coordinatorEnabled
      ? '这个项目开着 Automatic，所以任务做没做完由你判，不交给账号所有者逐张确认：'
        + 'EXECUTABLE 和 VERIFICATION 由平台自动判；EVIDENCE_JUDGMENT 由你读完证据后用 task_evidence_decide '
        + '判 CONFIRM 或 SEND_BACK，SEND_BACK 时写明下一版要证明什么。不要给任务声明 OWNER_CONFIRMED，'
        + '除非它服务的那条项目判据自己写明要账号所有者确认（verificationMethod 以 OWNER_CONFIRMED 开头）。\n\n'
        + '这个项目下的任务 DONE 之后，由平台把它落到项目的集成线上；落地的检查失败、超时或出错时，'
        + '集成待办会送到这里。这时任务本身已经做完，task_start 不会重新排落地：确认重跑会有不同结果（基线修好了、检查超时、'
        + '集成机器出错）就用 integration_retry 带理由重排一次，交付本身的问题用 task_reopen 退回返工。'
        + '这类落地去留由你判，不拿去问账号所有者。\n\n'
        + '要找账号所有者的只有三类：改或确认验收标准；上线与不可逆操作的事前授权；真正要账号所有者拍板的取舍。'
        + '拍板题用 ask_owner 发，每题附上你推荐的默认；能按默认推进的就按默认推进，别停下来等。\n\n'
      : '')
    + '没给你的工具就别去找：列出或删除项目、另开一个协调会话、直接指挥 runner，都不在你手上。'
  );
}

export function buildCoordinatorInstructions(
  title: string,
  projectId: string,
  coordinatorEnabled: boolean,
): string {
  return renderCoordinatorInstructions(
    `项目「${title}」（id: ${uuidToBase62(projectId)}）`,
    coordinatorEnabled,
  );
}

/**
 * What a session is told when the project it just recorded is coordinated by a DIFFERENT
 * conversation.
 *
 * A session coordinates at most one project, so a session that already has one cannot be promoted
 * again. Recording the project anyway and leaving it coordinated by nobody is what used to happen
 * — the caller was refused, dropped the session header, and retried — so `createInSession` now
 * opens the new project its own conversation, in this same workspace.
 *
 * It travels under the same key as the promotion, deliberately: both answer "what did recording
 * this project do to MY role", and a caller shown nothing would read the promotion's absence as
 * the promotion.
 */
export function buildDelegatedCoordinatorNotice(
  title: string,
  projectId: string,
  coordinatorSessionId: string,
): string {
  return (
    `项目「${title}」（id: ${uuidToBase62(projectId)}）已经记下了，但它的协调会话不是你。\n\n`
    + '你已经在协调另一个项目，而一个会话只能协调一个项目——所以已经在同一个 workspace 里为它开了'
    + `一条自己的协调会话（session id: ${uuidToBase62(coordinatorSessionId)}），项目从此指向那条会话。\n\n`
    + '你这边的角色没有变，手上还是原来那个项目。要跟进新项目就去那条会话；'
    + '在这里用 project_get / task_list 读它的状态也可以，但别在这条会话里替它做协调决定。'
  );
}

/** The repeatable delivery form carries only server-derived identity, never agent-written title. */
export function buildCoordinatorDeliveryInstructions(
  projectId: string,
  coordinatorEnabled: boolean,
): string {
  return renderCoordinatorInstructions(`项目（id: ${uuidToBase62(projectId)}）`, coordinatorEnabled);
}

/**
 * Identity of one coordinator context inside one live engine context.
 *
 * Binding the exact rendered instructions means an instruction edit automatically invalidates an
 * old acknowledgement — and so does flipping the project's Automatic switch, since the text
 * depends on it. The lease generation invalidates it on process restart, and the durable
 * compaction event seq invalidates it when the provider drops history without restarting.
 */
export function buildCoordinatorDeliveryContextKey(
  projectId: string,
  leaseGeneration: string,
  contextEpoch: number,
  coordinatorEnabled: boolean,
): string {
  return createHash('sha256')
    .update([
      'orbit-project-coordinator-context-v1',
      projectId,
      leaseGeneration,
      String(contextEpoch),
      buildCoordinatorDeliveryInstructions(projectId, coordinatorEnabled),
    ].join('\0'))
    .digest('hex');
}

/** The first user message for a coordinator created from the project page. */
export function buildCoordinatorOpening(
  title: string,
  projectId: string,
  coordinatorEnabled: boolean,
): string {
  return buildCoordinatorInstructions(title, projectId, coordinatorEnabled);
}

/** Whether the immutable project id shows that this session already opened as its coordinator. */
export function hasCoordinatorOpening(prompt: string, projectId: string): boolean {
  // Match the stable identity sentence rather than the whole prompt: project titles can change,
  // and tightening the instructions later must not make every dedicated coordinator receive two
  // copies. An arbitrary session that already contains this exact marker is already role-aware.
  return prompt.includes(`（id: ${uuidToBase62(projectId)}）的协调会话。`);
}

/**
 * Whether a dedicated coordinator's opening still says what delivery would say now.
 *
 * The opening is rendered once, when the session is created, and on the initial turn it stands in
 * for the delivery block that the turn's context key says was delivered. That holds only while its
 * body — everything after the identity line, the one part a title changes — is the current
 * rendering: an opening written before the Automatic switch flipped is not that context.
 */
export function coordinatorOpeningIsCurrent(
  prompt: string,
  projectId: string,
  coordinatorEnabled: boolean,
): boolean {
  const delivered = buildCoordinatorDeliveryInstructions(projectId, coordinatorEnabled);
  return (
    hasCoordinatorOpening(prompt, projectId)
    && prompt.includes(delivered.slice(delivered.indexOf('\n\n')))
  );
}

/** Append the canonical delivery block without making assumptions about how the role was gained. */
export function wrapCoordinatorDeliveryContext(
  content: string | undefined,
  projectId: string,
  coordinatorEnabled: boolean,
): string {
  const coordinatorInstructions = buildCoordinatorDeliveryInstructions(projectId, coordinatorEnabled);
  // This deliberately remains user-level context, matching the project-page opening. Project
  // title is agent-writable data and must never be promoted into a system/developer instruction.
  return (
    `${content ?? ''}\n\n<orbit_project_coordinator_context>\n${coordinatorInstructions}\n`
    + '</orbit_project_coordinator_context>'
  );
}

/** Add delivery-time role context to a promoted coordinator's next user/steer message. */
export function appendCoordinatorDeliveryContext(
  content: string | undefined,
  sessionPrompt: string,
  titleBeforeProjectManagement: string | null | undefined,
  project: { id: string; coordinatorEnabled: boolean } | null | undefined,
): string | undefined {
  if (
    !project
    || (titleBeforeProjectManagement == null && hasCoordinatorOpening(sessionPrompt, project.id))
  ) {
    return content;
  }
  // This deliberately remains user-level context, matching the project-page opening. Project
  // title is agent-writable data and must never be promoted into a system/developer instruction.
  // The stored ConversationTurn remains exactly what the person typed; this expansion is the same
  // delivery-time pattern used for #references and pending list events.
  return wrapCoordinatorDeliveryContext(content, project.id, project.coordinatorEnabled);
}
