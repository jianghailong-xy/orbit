import type { TaskCompletionCriterionValue } from './task-completion-criterion';

/**
 * The brief a task's run is handed as its opening turn — and what `task-start-card.ts` rebuilds to
 * prove a card says what the run was handed. In a module of its own so that rebuilding it does not
 * import `TasksService`: the turn cards are read inside `SessionsService` (sessions/turn-cards.ts),
 * and a TasksService loaded while SessionsService is still being defined would record an undefined
 * constructor dependency.
 */
export function buildTaskExecutionPrompt(task: {
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
  completionCriterion?: TaskCompletionCriterionValue | null;
  isForeman?: boolean;
  verifiesTaskId?: string | null;
  list?: { instructions?: string | null } | null;
}): string {
  const systemRun = task.isForeman === true || task.verifiesTaskId != null;
  const instructions = systemRun ? undefined : task.list?.instructions?.trim();
  // What would PROVE this task done, handed to the run that has to argue it is. It used to be
  // left out, which asked every run to answer "am I finished?" against criteria it had to go and
  // fetch with `task_get` — so a run that did not fetch them answered against the description
  // instead, and the description says what to DO and never what would settle it. Not suppressed
  // for a foreman or a verifier the way the list's instructions are: those describe how the
  // LIST's work is done and neither of those runs is doing it, whereas a task's own acceptance
  // criteria are about that task whoever is running it.
  const acceptance = task.acceptanceCriteria?.trim();
  const executableAcceptance =
    task.acceptanceCommand != null && task.acceptanceExpectedExitCode != null;
  // OWNER_CONFIRMED is settled only by the account owner pressing Confirm done in the app, so a run
  // of such a task has nothing to submit. Handed the evidence envelope like every other task, its
  // runs did as told and filed evidence that criterion never reads — often for a task in no
  // project, with no project_get criterion to copy.
  const ownerConfirmed = task.completionCriterion === 'OWNER_CONFIRMED';
  return (
    `请开始执行任务「${task.title}」。\n\n` +
    (task.description ? `任务描述：\n${task.description}\n\n` : '') +
    (acceptance ? `验收标准（判定本任务是否完成的依据）：\n${acceptance}\n\n` : '') +
    (instructions ? `作业指导（本任务列表通用）：\n${instructions}\n\n` : '') +
    `请按以下步骤进行：\n` +
    `1. 先用 task_get 查看该任务的完整信息与历史评论。\n` +
    `2. 执行任务。\n` +
    // Where the result goes is said as the platform writes it: the comparison writes task.status and
    // nothing else (runner-api.controller.ts turnComplete, held there by
    // executable-exit-code-judgment.spec.ts at the account owner's direction), so the brief must not
    // promise a comment carrying the output.
    (executableAcceptance
      ? `3. 完成本次回复后，系统会在本执行会话的工作区自动运行任务声明的唯一 EXECUTABLE 验收命令` +
        `（期望退出码 ${task.acceptanceExpectedExitCode}）；退出码相等则推导 DONE，否则推导 FAILED。` +
        `原始输出和实际退出码不会写入任务评论，结果记在这几处：推导出的状态写在任务上（task_get 可见）；` +
        `命令和原始输出在本会话的记录里，是其中一次 Bash 调用（要再看输出，就在工作区重跑同一条命令）；` +
        `FAILED 时本会话以失败结束，error 写着 \`acceptance command exited <实际退出码>; expected ` +
        `${task.acceptanceExpectedExitCode}\`（可用 session_get 读本会话，会话 id 在环境变量 ORBIT_SESSION_ID 里），` +
        `任务若属于项目，项目里还会多一条记下这两个退出码的 TASK_FAILED 异常。验收本身只在命令没能返回` +
        `可比较的结果时写一条任务评论（EXECUTABLE_ACCEPTANCE_UNAVAILABLE），任务状态保持不变。` +
        `不要自行写 status，也不要让 coordinator 审批这个机械结论。\n`
      : ownerConfirmed
        ? `3. 完成后，先用 task_request_confirmation（MCP；CLI 是 \`orbit task request-confirmation\`）`
          + `声明本次运行已经做完，再在本会话里用一两句话说明做了什么，然后结束本轮。`
          + `只有这条声明才会让账户所有者收到确认卡；不声明就不会有任何卡片——任务会一直停在 OPEN，`
          + `只能由所有者在任务面板里确认。卡片要等本次运行真的停下来（队列空、没有在飞的后台作业、`
          + `没有自己排的唤醒）那一轮结束时才交给所有者。本任务的完成判据是 OWNER_CONFIRMED：`
          + `由账户所有者在 Orbit app 里确认（Confirm done）或退回（Send back…），任何 agent 会话`
          + `（包括 coordinator）都无法代为确认；退回的理由会作为下一条消息进入本会话，收到后按理由继续，`
          + `再次做完时要重新声明一次。不要调用 task_evidence_submit，也不要写 status。\n`
        : `3. 完成后，用 task_evidence_submit 提交完成证据信封，四个字段缺一不可：claim（你主张完成了什么）、`
          + `criterion（{key, text}，抄自 project_get 的验收条目）、checks（每条 {kind, ref}，kind 取 `
          + `TOOL_CALL / COMMIT / ARTIFACT，ref 指向本任务会话下已有的行；至少一条必须解析成功，否则整次提交被拒）、`
          + `gaps（本次证据没能确立的部分，没有就给空数组）。TOOL_CALL 可再写 command/succeeded，服务端会拿它`
          + `和被引 tool_call 逐字节核对。不要把命令原始输出抄进证据——Orbit 已经存了它；只由退出码回答的工作`
          + `属于 EXECUTABLE 验收，不属于这里。不要用 task_comment 代替证据提交，也不要写 status——DONE 是`
          + `解锁下游任务的授权，只能由任务声明的 completionCriterion 求值产生；服务端会拒绝任何主体直接写 DONE。\n`) +
    `4. 如果执行失败或未能完成，先用 task_comment 说明失败/未完成的原因，再用 task_update 将` +
    `状态（status）置为 FAILED。不要置为 DONE，也不要置为 IN_PROGRESS——IN_PROGRESS 会被下游` +
    `当成普通等待一直等下去，FAILED 才会把下游标成需要人介入。`
  );
}
