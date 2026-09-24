import { CreatorType, Prisma } from '@prisma/client';
import {
  SOURCE_FIX_ACTIONS,
  SOURCE_REFUSAL_CODES,
  SourceFixAction,
  SourceRefusalCode,
  TaskDispatchRefusal,
  uuidToBase62,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { branchName, LANDED_RESULTS } from '../projects/project-criterion-landing';
import { hasResolvedSource } from '../projects/session-source';

/**
 * A start that never became a run, recorded where somebody will see it.
 *
 * WHAT THIS IS ABOUT
 * ==================
 * A run whose SOURCE is resolved is pinned first and checked out second, and the checkout is where
 * the runner applies the admission gate's last three levels (`setupSourceWorktree`,
 * src/runner-go/worktree.go): the pinned commit must exist (G4), must contain every commit
 * `requiredContains` names (G5), and must take an isolated worktree (G6). A refusal there spawns no
 * engine; the run ends FAILED with `<code>: <reason>` as its error, and that is all the runner says.
 *
 * Until this module, that error was also all there was. The task was never moved — a start does not
 * set IN_PROGRESS, so `reclaimStalledTask` had nothing to reclaim — no exception item was opened,
 * and no wake was written: on 2026-09-23 a project stood still on one of these with nothing in the
 * system saying so except one session's error line, and a generic comment beneath it that said to
 * run the task again, which is the one thing that cannot help (a new start pins the same tip and
 * requires the same commits).
 *
 * So the finalize that ends such a run records the refusal on the TASK — `task.dispatch_refusal`,
 * the shape `TaskDispatchRefusal` gives it — writes the refusal and its next step on the task's
 * timeline instead of the generic failure note, and, once committed, delivers it to the project's
 * standing coordinator conversation (`projects/task-dispatch-refusal.producer.ts`).
 *
 * THE OTHER GATE, WHICH SAID NOTHING FOR LONGER
 * =============================================
 * Resolution is the gate BEFORE the checkout, and it can refuse the same way and just as quietly: a
 * ref that does not exist stops the start at `git fetch` (BASE_REF_NOT_FOUND), before any pin, and
 * the runner reports that refusal through the pin door rather than through a finalized run. Until
 * this record covered it, such a start left the session at REFUSED and NOTHING ELSE — on
 * 2026-09-23 (project 34TsjwkAMVVkeEUwi2IAJ) one kept a session idle for 5.5 hours with the task
 * row untouched, no exception item and no wake row, and was found by a person who happened to look.
 * `freezeSessionSourcePin` records it here now, in the same transaction that refuses the session.
 *
 * WHY THE CHECKOUT'S SESSION CANNOT SAY IT ITSELF
 * ===============================================
 * The refusal is decided after the pin froze, and migration 0231's freeze guard lets a session's
 * `source_state` leave SELECTED only: a PINNED run does not become REFUSED. That is deliberate — the
 * pin is the fact every recovery path reads — and it means the one structured place a checkout
 * refusal could live on the session is closed to it. The error line is where the runner puts it, and
 * this is where it is read. A RESOLUTION refusal has no such problem (its session IS REFUSED, and
 * carries the code), and it is recorded here anyway: the reader who has to see that a task could not
 * start is a reader of the task, and two shapes of the same fact is one shape more than anybody
 * needs.
 *
 * WHAT THIS DOES NOT DO
 * =====================
 * It does not relax the gate. Nothing here decides whether a run may start: the runner does, on a
 * checkout, with git. This only makes the answer it already gave visible, and names what would
 * change it.
 */

/** The marker the refusal's comment opens with, so a reader of the raw timeline can find them. */
export const DISPATCH_REFUSED_SIGNAL_CODE = 'TASK_DISPATCH_REFUSED';

/** A run whose start was refused, in the columns reading its refusal needs. */
export interface RefusedRunSource {
  id: string;
  sourceState: string;
  sourceRef: string | null;
  sourceBaseSha: string | null;
  sourceRequiredContains: string[];
}

/**
 * The refusal in a failed run's last words, or null when they are anything else.
 *
 * The runner writes a checkout refusal as `<code>: <reason>` (`runSessionProcess`,
 * src/runner-go/session.go), and a run that got that far has a resolved SOURCE — a Legacy session
 * never reaches `setupSourceWorktree`. Both halves are required, so an engine whose own error
 * happens to begin with an upper-case word is not mistaken for one, and any §10.1 code counts: the
 * table is the one list of what a SOURCE refusal can be called, and a second, narrower list here
 * would be a copy of it free to fall behind.
 *
 * The checkout is the second of the two gates that can refuse and say nothing: the first is
 * resolution, which stops BEFORE a pin exists and reaches this record through the pin door instead
 * — see `recordDispatchRefusal`.
 */
export function readDispatchRefusal(
  error: string | null | undefined,
  run: Pick<RefusedRunSource, 'sourceState'>,
): { code: SourceRefusalCode; reason: string } | null {
  if (!error || !hasResolvedSource(run.sourceState)) return null;
  const said = /^([A-Z][A-Z_]+): ([\s\S]+)$/.exec(error.trim());
  if (!said || !(SOURCE_REFUSAL_CODES as readonly string[]).includes(said[1]!)) return null;
  return { code: said[1] as SourceRefusalCode, reason: said[2]!.trim() };
}

/**
 * Record the refusal on the task, and on its timeline, inside the transaction that decided it — so
 * one refused start leaves exactly one of each, and a transaction that lost its race leaves neither.
 *
 * TWO DOORS, ONE RECORD
 * =====================
 * `runnerApi.finalize` calls this for a run the runner refused at its CHECKOUT, inside the
 * transaction that settles that run (`readDispatchRefusal` read the code out of the run's last
 * words). `runnerApi.pinSessionSource` calls it for a run the runner refused at RESOLUTION, inside
 * the transaction that moves the session to REFUSED, with what that freeze reported — there the
 * code arrives structured, in the refusal the runner posted, and the session's own column carries it
 * too (SELECTED becomes REFUSED freely; it is the PINNED half of that transition migration 0231
 * freezes).
 *
 * Both gates are the runner's, both end the start with no engine, and a reader of the task should
 * not have to know which of them stopped it to see that it stopped: one column, one shape, one
 * wake, whether the answer came from a checkout or from the fetch that precedes one.
 *
 * The missing commits are the required ones the runner NAMED, less the commit it stood on: a commit
 * is its own ancestor, so the pin is never missing, and it is named in every one of these messages.
 * Reading the list off `requiredContains` rather than parsing the sentence is what keeps this from
 * depending on how the runner phrases it — the only thing taken from the words is which of the
 * commits the session was frozen with they mention. A resolution refusal has no pin at all, so
 * `run.sourceBaseSha` is null and its message names none: the list is empty, not unread.
 */
export async function recordDispatchRefusal(
  tx: Prisma.TransactionClient,
  taskId: string,
  run: RefusedRunSource,
  refused: { code: SourceRefusalCode; reason: string },
  at: Date,
): Promise<TaskDispatchRefusal> {
  const missing = run.sourceRequiredContains.filter(
    (sha) => sha !== run.sourceBaseSha && refused.reason.includes(sha),
  );
  const landedBy = await prerequisitesThatLanded(tx, taskId, missing);
  const refusal: TaskDispatchRefusal = {
    code: refused.code,
    fixAction: SOURCE_FIX_ACTIONS[refused.code],
    refusedAt: at.toISOString(),
    sessionId: run.id,
    baseSha: run.sourceBaseSha,
    ref: run.sourceRef,
    missing: missing.map((sha) => ({ sha, taskId: landedBy.get(sha)?.id ?? null })),
    reason: refused.reason,
  };
  const task = await tx.task.update({
    where: { id: taskId },
    data: { dispatchRefusal: refusal as unknown as Prisma.InputJsonValue },
    select: { assigneeId: true, creatorType: true, creatorId: true },
  });
  await tx.taskComment.create({
    data: {
      taskId,
      authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
      authorId: task.assigneeId ?? task.creatorId,
      body: dispatchRefusalComment(refusal, landedBy),
    },
  });
  return refusal;
}

/**
 * Which prerequisite landed each of these commits, by the receipts the closure was built from.
 *
 * The receipts `prerequisiteLandingCommits` reads (projects/session-source.ts): a MERGED receipt's
 * commit is where it moved the target, an ALREADY_MERGED one's is the source it found there, and a
 * promotion of the line names the line's commit as its source — so both columns are matched, and
 * the answer does not depend on which of them the closure took.
 */
async function prerequisitesThatLanded(
  tx: Prisma.TransactionClient,
  taskId: string,
  shas: readonly string[],
): Promise<Map<string, { id: string; title: string }>> {
  if (shas.length === 0) return new Map();
  const edges = await tx.taskDependency.findMany({
    where: { taskId },
    select: { dependsOnTask: { select: { id: true, title: true } } },
  });
  const prerequisites = new Map(edges.map((edge) => [edge.dependsOnTask.id, edge.dependsOnTask]));
  if (prerequisites.size === 0) return new Map();
  const receipts = await tx.sessionMergeReceipt.findMany({
    where: {
      taskId: { in: [...prerequisites.keys()] },
      result: { in: [...LANDED_RESULTS] },
      OR: [{ targetShaAfter: { in: [...shas] } }, { sourceSha: { in: [...shas] } }],
    },
    select: { taskId: true, sourceSha: true, targetShaAfter: true },
    orderBy: { createdAt: 'asc' },
  });
  const landedBy = new Map<string, { id: string; title: string }>();
  for (const receipt of receipts) {
    const prerequisite = receipt.taskId ? prerequisites.get(receipt.taskId) : undefined;
    if (!prerequisite) continue;
    for (const sha of [receipt.targetShaAfter, receipt.sourceSha]) {
      if (sha && shas.includes(sha) && !landedBy.has(sha)) landedBy.set(sha, prerequisite);
    }
  }
  return landedBy;
}

/**
 * What to do about a refusal, in the words a person or a coordinator acts on.
 *
 * One sentence per fixAction, read by the task's comment and by the coordinator's message alike, so
 * the two cannot give different advice about the same refusal. Every one of them ends the same way,
 * because it is the thing the old note got wrong: starting the task again changes nothing until the
 * cause has.
 */
export function dispatchRefusalNextStep(
  refusal: { fixAction: SourceFixAction | string; ref: string | null },
): string {
  const again = '在那之前重新开工只会得到同一个拒绝。';
  const line = refusal.ref ? `集成线 ${branchName(refusal.ref)}` : '这次起跑的线';
  switch (refusal.fixAction) {
    case 'SYNC_INTEGRATION_LINE':
      return (
        `前置已经落地了——缺的是它落地的提交不在${line}上：前置的成果进了 upstream，而这条线还没吸收 `
        + 'upstream。先让这条线追上它（下一次任务落地时的 main 同步会做；等不及就从这条线的 tip 出发把 '
        + 'upstream 合进来、推回这条线，不 rebase、不 force push），再开工。'
        + '在那之前重新开工只会得到同一个拒绝：新的开工从同一个 tip 起跑，要求的是同一组提交。'
      );
    case 'FIX_REF':
      // §10.1's one code whose cause is the line itself: there is nothing to sync and nothing to
      // restore, the ref the run was told to start from simply is not there. Said without naming a
      // gate, because the answer is the same whether the runner found that out with `ls-remote`
      // before a pin or with a checkout after one.
      return (
        `解析的时候仓库里没有 ${refusal.ref ? `\`${refusal.ref}\`` : '这次起跑要用的 ref'}：`
        + '它还不存在、已经被删掉，或者和项目绑定里的名字对不上。先把它建出来'
        + '（这个项目在这条线上的第一次落地会创建它），或者把绑定的 integrationRef 改成实际存在的那一条，'
        + '再开工。' + again
      );
    case 'RESTORE_COMMIT':
      return '执行它的 runner 的仓库里没有这次钉住的提交：把它取回或恢复到那个仓库里，再开工。' + again;
    case 'ENABLE_ISOLATION':
      return (
        'runner 没能在钉住的提交上建出独立的 worktree：确认这个工作区的 workDir 是 git 仓库、'
        + '没有关掉 worktree 隔离，并按上面 runner 的原话排查 `git worktree add` 的报错，再开工。' + again
      );
    default:
      return `按处置 ${refusal.fixAction} 修好之后再开工。` + again;
  }
}

/** The note the refusal leaves on the task's own timeline, in place of the generic failure note. */
function dispatchRefusalComment(
  refusal: TaskDispatchRefusal,
  landedBy: ReadonlyMap<string, { id: string; title: string }>,
): string {
  const base = refusal.baseSha
    ? `${refusal.ref ? `${branchName(refusal.ref)} @ ` : ''}\`${refusal.baseSha}\``
    : null;
  const missing = refusal.missing.map(({ sha }) => {
    const prerequisite = landedBy.get(sha);
    return prerequisite
      ? `- \`${sha}\`，前置「${prerequisite.title}」（${uuidToBase62(prerequisite.id)}）落地的提交`
      : `- \`${sha}\``;
  });
  return (
    `<!-- orbit:${DISPATCH_REFUSED_SIGNAL_CODE} -->\n`
    + '**开工被拒（系统自动记录）**\n\n'
    + '这次开工没有变成一次运行：runner 在启动引擎之前拒绝了它，没有引擎被拉起，任务状态没有被改动。'
    + '拒绝发生在哪一级看拒绝码——解析这次起跑的 ref 失败，或解析通过之后检出被拒。\n'
    + '拒绝记在任务的 dispatchRefusal 上，并投递给项目的协调会话（协调开关关掉时投递会被拒，拒绝本身仍在）。\n\n'
    + `拒绝码：${refusal.code}（处置：${refusal.fixAction}）\n`
    + (base ? `钉住的提交：${base}\n` : '')
    + (missing.length > 0 ? `它不包含的前置落地提交：\n${missing.join('\n')}\n` : '')
    + `\n下一步：${dispatchRefusalNextStep(refusal)}\n\n`
    + `runner 的原话：\n${refusal.code}: ${refusal.reason}\n\n`
    + `信号来源：${DISPATCH_REFUSED_SIGNAL_CODE}`
  );
}

/**
 * Another run is away on this task, so the refusal its previous start met is history.
 *
 * Called where every start door puts a run on a task (`TasksService.applyWorkspaceRun`). The
 * condition is what keeps it from racing the run it was called for: a refusal recorded for THIS run
 * — its finalize can in principle commit before this statement does — names this run's session and
 * is left standing. The refused run's own session, comment and wake row stay as they were; only the
 * task stops saying its latest start was refused.
 */
export async function clearDispatchRefusal(
  prisma: PrismaService,
  taskId: string,
  runSessionId: string,
): Promise<boolean> {
  const cleared = await prisma.$executeRaw(Prisma.sql`
    UPDATE "task"
       SET "dispatch_refusal" = NULL, "updated_at" = ${new Date()}
     WHERE "id" = ${taskId}::uuid
       AND "dispatch_refusal" IS NOT NULL
       AND ("dispatch_refusal" ->> 'sessionId') IS DISTINCT FROM ${runSessionId}
  `);
  return cleared > 0;
}
