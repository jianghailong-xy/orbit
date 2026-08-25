import { uuidToBase62 } from '@orbit/shared';

/** The title a coordination session is filed under. */
export function coordinatorSessionTitle(projectTitle: string): string {
  // "Coordinator" is a role, rendered as a badge; putting it in the mutable title duplicates
  // metadata and makes the project and its conversation acquire two different names. Both columns
  // are TEXT, so keep the identity exact rather than silently truncating one side.
  return projectTitle;
}

/**
 * The message a coordination session opens on.
 *
 * A coordinator is driven by the person talking to it. The control loop that used to open turns on
 * its own is gone, so this says what the project is, where to read its real state, and which tools
 * are in reach — and deliberately says nothing about an automation policy, because nothing acts on
 * one any more. Promising a stance no code enforces is worse than promising nothing.
 *
 * Unit T6 took two claims out of it. This used to say `project_update` was for the acceptance
 * criteria and for recording `status = DONE`, and both of those are a person's: the criteria are
 * the exam this project is judged against, and DONE is the statement that its goal was met. The
 * person driving this conversation can still write either — they are the one signed in, and
 * `coordinator-authority.ts` restricts only the one-shot judgment session — but a coordinator told
 * they are its tools is a coordinator that will offer to do them rather than ask, which is the
 * shape of every irreversible write nobody meant to authorise. So the opening names who decides.
 */
export function buildCoordinatorOpening(title: string, projectId: string): string {
  return (
    `你是项目「${title}」（id: ${uuidToBase62(projectId)}）的协调会话。\n\n`
    + '这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。\n\n'
    + '先读再说：用 project_get 读这个项目的目标、验收标准和作业指导，再用 task_list（projectId 传上面那个 id）'
    + '看它下面的任务各自停在哪里。这两样都不在任务的描述里，不读就只能靠猜。读完先简短汇报现状。\n\n'
    + '推进靠的是跟人对话：把现状说清楚，该问的问，商量下一步，然后动手。没有任何自动的环会替你决定什么时候动。\n\n'
    + '该动的时候你手上有工具：project_update 改这个项目的标题、目标、作业指导；'
    + 'task_create、task_update、task_start 管它下面的任务。\n\n'
    + '有两件事不是你来定：改这个项目的验收标准，和把它记成 DONE。'
    + '验收标准是判定这个项目做没做完的那把尺子，改尺子的人可以让任何结论成立；'
    + 'DONE 是「目标达成了」这句话本身，说错了没有下游会再问一遍。'
    + '这两件都由人来写——你把该改什么、还差什么说清楚，让屏幕这边的人决定。\n\n'
    + '没给你的工具就别去找：列出或删除项目、另开一个协调会话、直接指挥 runner，都不在你手上。'
  );
}
