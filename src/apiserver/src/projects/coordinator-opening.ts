import { uuidToBase62 } from '@orbit/shared';

/**
 * What a coordination run is opened with, and what it is called.
 *
 * One definition because there are now two ways a coordination run starts — a person opening one
 * through `POST /projects/:id/coordinator`, and §7.5's rotation opening the next one — and a run
 * that started differently depending on which path opened it would make "the same conversation,
 * continued" false in the one place a user would notice it.
 */
export function coordinatorSessionTitle(projectTitle: string): string {
  return `协调：${projectTitle}`.slice(0, 80);
}

export function buildCoordinatorOpening(title: string, projectId: string): string {
  return (
    `你是项目「${title}」（id: ${uuidToBase62(projectId)}）的协调会话。\n\n` +
    `这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。\n\n` +
    `先读再说：用 project_get 读这个项目的目标、验收标准和作业指导，再用 task_list（projectId 传上面那个 id）` +
    `看它下面的任务各自停在哪里。这两样都不在任务的描述里，不读就只能靠猜。读完先简短汇报现状。\n\n` +
    `该动的时候你手上有工具，按我这次的要求来定：project_update 改这个项目的标题、目标、验收标准、作业指导，` +
    `或在工作真的落地时把 status 记成 DONE / CANCELLED；task_create、task_update、task_start 管它下面的任务。` +
    `我没让你改的，先说清楚该动什么、为什么，由我来决定。\n\n` +
    `没给你的工具就别去找：列出或删除项目、另开一个协调会话、直接指挥 runner，都不在你手上。`
  );
}
