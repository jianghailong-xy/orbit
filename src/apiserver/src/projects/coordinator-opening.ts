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

/** §7.2's `reasonCode`, in the words the person reading the transcript needs. */
const TURN_REASON_TEXT: Record<string, string> = {
  MANUAL: '有人按了「现在看一下这个项目」',
  VERDICT: '一个验证任务给出了非 PASS 的结论',
  TASK_FAILURE: '这个项目下有任务已经失败并停住了，控制环自己动不了它',
  BLOCKER_DECISION: '有一条需要你决定的 blocker',
  ACCEPTANCE: '项目验收需要你的判断',
  REPLAN: '没有可派发的工作，需要你重新规划',
};

/** How much of `turnFacts` rides in the message. The whole projection is on the action row; this
 *  is the part a reader sees, and a turn that pasted an unbounded list would be unreadable long
 *  before it hit `MAX_PROMPT_CHARS`. */
const TURN_FACTS_CHARS = 2_000;

/**
 * What §7.6 delivers into a live coordination run: one ordinary message, and deliberately nothing
 * cleverer than that.
 *
 * It is a `message` and not a `steer` because a coordination turn has to be answerable and
 * completable on its own — a steer is written into whatever turn is already running and produces no
 * reply of its own, so a turn the control loop cannot tell "answered" from "swallowed" would make
 * §7.6 TR3's whole premise ("the last turn changed none of its facts") unreadable.
 *
 * The ids are in the text on purpose. The action row is the authority, but the coordinator reads
 * the transcript, and a wake whose reason cannot be quoted back is one nobody can audit from the
 * conversation it happened in.
 */
export function buildCoordinatorTurnMessage(turn: {
  reasonCode: string;
  reasonDigest: string;
  turnFacts: unknown;
  suppressed: readonly string[];
  decisionId: string;
  actionId: string;
}): string {
  const facts = JSON.stringify(turn.turnFacts ?? null);
  const lines = [
    `控制环叫醒你：${TURN_REASON_TEXT[turn.reasonCode] ?? turn.reasonCode}（reasonCode: ${turn.reasonCode}）。`,
    '',
    '下面是控制环在做出这个决定的那一刻看到的事实。它是快照，不是现在——先用 project_get 和 '
    + 'task_list 把当前状态读一遍再动手，不要直接照着这段往下做。',
    '',
    '```json',
    facts.length > TURN_FACTS_CHARS ? `${facts.slice(0, TURN_FACTS_CHARS)}…（已截断）` : facts,
    '```',
    '',
    `- decision: ${turn.decisionId}`,
    `- action: ${turn.actionId}`,
    `- reasonDigest: ${turn.reasonDigest}`,
    ...(turn.suppressed.length > 0 ? [`- 同时成立但被顺序压过的原因: ${turn.suppressed.join(', ')}`] : []),
    '',
    '这一轮属于你：该做什么、做完了没有，由你在这条会话里说清楚。如果你看完认为不需要动，'
    + '也把这个结论说出来——控制环靠你这一轮有没有改变上面那些事实来判断要不要再叫你。',
  ];
  return lines.join('\n');
}
