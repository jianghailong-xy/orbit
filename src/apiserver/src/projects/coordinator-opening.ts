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
 * in reach — and deliberately says nothing about an automation policy, because nothing acts on
 * one any more. The authenticated channel is useful provenance, but is not by itself proof that a
 * human rather than a credential holder is present.
 *
 * Unit T6 took two claims out of it. This used to say `project_update` was for the acceptance
 * criteria and for recording `status = DONE`, and both are routed to owner review: the criteria
 * are the exam this project is judged against, and DONE is the statement that its goal was met.
 * The owner-authenticated channel can still write either, while `coordinator-authority.ts`
 * restricts only the one-shot judgment session. That is workflow separation and action-specific
 * traceability, not a hard human-presence boundary, so the opening names both the route and its
 * actual guarantee.
 */
function renderCoordinatorInstructions(projectIdentity: string): string {
  return (
    `你是${projectIdentity}的协调会话。\n\n`
    + '这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。\n\n'
    + '先读再说：用 project_get 读这个项目的目标、验收标准和作业指导，再用 task_list（projectId 传上面那个 id）'
    + '看它下面的任务各自停在哪里。这两样都不在任务的描述里，不读就只能靠猜。读完先简短汇报现状。\n\n'
    + '推进靠的是跟人对话：把现状说清楚，该问的问，商量下一步，然后动手。没有任何自动的环会替你决定什么时候动。\n\n'
    + '该动的时候你手上有工具：project_update 改这个项目的标题、目标、作业指导；'
    + 'task_create、task_update、task_start 管它下面的任务。\n\n'
    + '有两件事不是你来定：改这个项目的验收标准，和把它记成 DONE。'
    + '验收标准是判定这个项目做没做完的那把尺子，改尺子的人可以让任何结论成立；'
    + 'DONE 是「目标达成了」这句话本身，说错了没有下游会再问一遍。'
    + '这两件都由账号所有者通道记录——你把该改什么、还差什么说清楚，让屏幕这边的账号所有者决定。'
    + '这里的 HUMAN_ONLY 是角色隔离和按动作留痕，不是服务器对“真人在场”的密码学证明。\n\n'
    + '没给你的工具就别去找：列出或删除项目、另开一个协调会话、直接指挥 runner，都不在你手上。'
  );
}

export function buildCoordinatorInstructions(title: string, projectId: string): string {
  return renderCoordinatorInstructions(`项目「${title}」（id: ${uuidToBase62(projectId)}）`);
}

/** The repeatable delivery form carries only server-derived identity, never agent-written title. */
export function buildCoordinatorDeliveryInstructions(projectId: string): string {
  return renderCoordinatorInstructions(`项目（id: ${uuidToBase62(projectId)}）`);
}

/** The first user message for a coordinator created from the project page. */
export function buildCoordinatorOpening(title: string, projectId: string): string {
  return buildCoordinatorInstructions(title, projectId);
}

/** Whether the immutable project id shows that this session already opened as its coordinator. */
function hasCoordinatorOpening(prompt: string, projectId: string): boolean {
  // Match the stable identity sentence rather than the whole prompt: project titles can change,
  // and tightening the instructions later must not make every dedicated coordinator receive two
  // copies. An arbitrary session that already contains this exact marker is already role-aware.
  return prompt.includes(`（id: ${uuidToBase62(projectId)}）的协调会话。`);
}

/** Add delivery-time role context to a promoted coordinator's next user/steer message. */
export function appendCoordinatorDeliveryContext(
  content: string | undefined,
  sessionPrompt: string,
  titleBeforeProjectManagement: string | null | undefined,
  project: { id: string } | null | undefined,
): string | undefined {
  if (
    !project
    || (titleBeforeProjectManagement == null && hasCoordinatorOpening(sessionPrompt, project.id))
  ) {
    return content;
  }
  const coordinatorInstructions = buildCoordinatorDeliveryInstructions(project.id);
  // This deliberately remains user-level context, matching the project-page opening. Project
  // title is agent-writable data and must never be promoted into a system/developer instruction.
  // The stored ConversationTurn remains exactly what the person typed; this expansion is the same
  // delivery-time pattern used for #references and pending list events.
  return (
    `${content ?? ''}\n\n<orbit_project_coordinator_context>\n${coordinatorInstructions}\n`
    + '</orbit_project_coordinator_context>'
  );
}
