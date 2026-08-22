import { uuidToBase62 } from '@orbit/shared';
import {
  PROJECT_POLICY_MATRIX,
  ProjectAutomationPolicyValue,
  ProjectPolicyRowId,
  projectPolicyCell,
} from './project-authorization.service';

/**
 * §9.2's rows, in the words the coordinator needs (v1.18, `PC-CX-65`).
 *
 * Derived rather than restated: the sentences below are attached to the matrix's row ids, and the
 * paragraph is assembled by ASKING the matrix which cell each row is in under this project's
 * policy. A row added to §9.2 without a line here fails the contract test — which is the point.
 * Before this existed the opening said the same thing to every project: "我没让你改的，先说清楚该
 * 动什么、为什么，由我来决定". That is MANUAL's sentence, and it was being handed to GUARDED_AUTO
 * and AUTO projects whose control loop dispatches, retries and runs acceptance on its own — the
 * coordinator was told to wait for a person who was not coming.
 */
const POLICY_ROW_TEXT: Readonly<Record<ProjectPolicyRowId, string>> = {
  ALWAYS_SAFE: '记事实、开/清 blocker、聚合父任务、安排下一次检查',
  DISPATCH_INITIAL: '把就绪的任务派发出去',
  DISPATCH_RETRY: '失败的任务在退避到期后重试（还没到上限、失败有归因）',
  DISPATCH_MAX_ATTEMPTS: '重试上限用完、或失败没有归因之后，再派发同一个任务',
  DISPATCH_OVER_LIMIT: '超出并发上限或当日 Session 预算之后，再派发',
  DISPATCH_PROVIDER_FALLBACK: '换一个 provider 兜底派发',
  COORDINATOR_ROUTINE: '叫醒这条协调会话、在它结束后轮换出下一条',
  PROJECT_ACCEPTANCE: '跑项目级验收',
  USER_CONTROL_ONLY: '删任务、删项目、改验收标准、改派任务',
};

/** The three buckets a row can be in, and what being in one means for this conversation. */
function policyParagraph(policy: ProjectAutomationPolicyValue): string {
  const allowed: string[] = [];
  const approval: string[] = [];
  const refused: string[] = [];
  const humanOnly: string[] = [];
  for (const row of PROJECT_POLICY_MATRIX) {
    const text = POLICY_ROW_TEXT[row.id];
    const cell = projectPolicyCell(policy, row.id);
    if (cell === 'ALLOW') allowed.push(text);
    else if (cell === 'REQUIRE_APPROVAL') approval.push(text);
    else if (row.risk === 'PROHIBITED') humanOnly.push(text);
    else refused.push(text);
  }
  const lines = [`当前自动化策略是 ${policy}，控制环按它办事：`];
  if (allowed.length > 0) lines.push(`- 它自己就会做，不用问人：${allowed.join('；')}。`);
  if (approval.length > 0) lines.push(`- 它要先拿到人的批准才做：${approval.join('；')}。`);
  if (refused.length > 0) lines.push(`- 这些情况它会直接拒绝，等条件变了再自己重来：${refused.join('；')}。`);
  if (humanOnly.length > 0) lines.push(`- 永远只能由人来做：${humanOnly.join('；')}。`);
  return lines.join('\n');
}

/**
 * What this conversation is FOR under the current policy — the one sentence that used to be
 * hardcoded to MANUAL.
 *
 * The distinction is not decoration: under `GUARDED_AUTO` / `AUTO` a coordinator that sits and
 * waits for a person to start the next task is waiting for something that already happened, and
 * §10.1 AC3's silent idling is what that looks like from outside.
 */
const POLICY_STANCE: Readonly<Record<ProjectAutomationPolicyValue, string>> = {
  MANUAL: '这个项目设成 MANUAL：控制环不会自己派发任何任务，也不会自己重试失败的任务。'
    + '所以下一步要动什么、为什么，你说清楚，由人来按下开始。',
  GUARDED_AUTO: '这个项目设成 GUARDED_AUTO：就绪的任务控制环会自己派出去，失败的任务它也会按退避'
    + '自己重试到上限——这两件事你不用替它按。你的活是判断方向、拆解与合并、以及在它拿不定主意'
    + '（重试上限用完、验收、换 provider）时给出结论。',
  AUTO: '这个项目设成 AUTO：派发、重试、验收、provider 兜底控制环都会自己做完。'
    + '你的活是判断这些自动做出来的结果对不对、缺什么，以及在需要改变方向时说出来。',
};

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

export function buildCoordinatorOpening(
  title: string,
  projectId: string,
  /**
   * §9.2's policy for THIS project, read from the row that is opening the run. Defaulted for the
   * one caller that legitimately has none — a test or an old caller — and the default is the
   * strictest of the three, so a missing policy can only under-promise.
   */
  policy: ProjectAutomationPolicyValue = 'MANUAL',
): string {
  return (
    `你是项目「${title}」（id: ${uuidToBase62(projectId)}）的协调会话。\n\n` +
    `这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。\n\n` +
    `先读再说：用 project_get 读这个项目的目标、验收标准和作业指导，再用 task_list（projectId 传上面那个 id）` +
    `看它下面的任务各自停在哪里。这两样都不在任务的描述里，不读就只能靠猜。读完先简短汇报现状。\n\n` +
    `${POLICY_STANCE[policy]}\n\n` +
    `${policyParagraph(policy)}\n\n` +
    `策略是可以被改的：以你 project_get 读到的 automationPolicy 为准，别把上面这段当成永久事实。\n\n` +
    `该动的时候你手上有工具：project_update 改这个项目的标题、目标、验收标准、作业指导，` +
    `或在工作真的落地时把 status 记成 DONE / CANCELLED；task_create、task_update、task_start 管它下面的任务。\n\n` +
    `没给你的工具就别去找：列出或删除项目、另开一个协调会话、直接指挥 runner，都不在你手上。`
  );
}

/** §7.2's `reasonCode`, in the words the person reading the transcript needs. */
const TURN_REASON_TEXT: Record<string, string> = {
  MANUAL: '有人按了「现在看一下这个项目」',
  VERDICT: '一个验证任务给出了非 PASS 的结论',
  TASK_FAILURE: '这个项目下有任务失败后停住了：自动重试要么已经用完，要么这次失败没有归因，'
    + '控制环没有任何机械动作能推进它',
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
  /**
   * §9.2's policy as the delivering transaction read it (v1.18, `PC-CX-65`).
   *
   * A turn is not the same instruction under all three: under `MANUAL` the coordinator is being
   * asked what a person should do, and under `AUTO` it is being asked what IT should do. The
   * opening said one of those to everybody, and it was written before the loop could dispatch at
   * all — so a turn that repeated only the opening's stance would keep answering with a policy the
   * project may have left months ago. It is defaulted for the same reason the opening's is, and it
   * is deliberately read fresh per turn rather than inherited from the run's first message.
   */
  automationPolicy?: ProjectAutomationPolicyValue;
}): string {
  const policy = turn.automationPolicy ?? 'MANUAL';
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
    POLICY_STANCE[policy],
    '',
    '这一轮属于你：该做什么、做完了没有，由你在这条会话里说清楚。如果你看完认为不需要动，'
    + '也把这个结论说出来——控制环靠你这一轮有没有改变上面那些事实来判断要不要再叫你。',
  ];
  return lines.join('\n');
}
