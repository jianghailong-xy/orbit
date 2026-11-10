import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { orchestrationEnabled } from '../common/orchestration-switch';
import { COORDINATOR_PAUSE_SELECT, conversationIsPaused } from '../projects/coordinator-evidence-queue';
import { conversationIsOver } from '../projects/project-open-item';
import { openFuseEpisodeId } from '../projects/project-fuse';
import { runItemHold } from '../projects/run-item-hold';
import { attribute, readBlockSender } from './session-message';

export const RUN_QUESTION_PREFIX = 'run-question:v1:';
type Db = Prisma.TransactionClient;

export function questionApprovalId(key: string | null | undefined): string | null {
  if (!key?.startsWith(RUN_QUESTION_PREFIX)) return null;
  return /^([0-9a-f-]{36})(?::|$)/i.exec(key.slice(RUN_QUESTION_PREFIX.length))?.[1] ?? null;
}

/** Read again inside the turn transaction: a coordinator rotation must not misaddress a question. */
export async function questionRecipient(db: Db, sessionId: string) {
  const run = await db.session.findUnique({ where: { id: sessionId }, select: {
    ownerId: true, task: { select: { project: true } }, owner: { select: { preferences: true } },
  } });
  const project = run?.task?.project;
  if (!run || !project?.coordinatorEnabled) return null;
  const coordinator = project.coordinatorSessionId
    ? await db.session.findUnique({ where: { id: project.coordinatorSessionId }, select: COORDINATOR_PAUSE_SELECT }) : null;
  const reason = !project.coordinatorSessionId ? 'NO_COORDINATOR'
    : !coordinator || conversationIsOver(coordinator) ? 'REVIEWER_ENDED'
    : conversationIsPaused(coordinator) || await openFuseEpisodeId(db, project.id) ? 'COORDINATOR_PAUSED'
    : project.coordinatorSessionId === sessionId || !orchestrationEnabled(run.owner) ? 'UNREACHABLE' : null;
  return { ownerId: run.ownerId, project, reason };
}

/** The same F decision feeds every owner-facing reader, including the alert edge. */
export async function questionHolds(db: Db, approvalIds: string[], now = new Date()) {
  const result = new Map<string, ReturnType<typeof runItemHold>>();
  if (!approvalIds.length) return result;
  const requests = await db.sessionRequest.findMany({ where: { kind: 'RUN_QUESTION', approvalId: { in: approvalIds } } });
  for (const request of requests) {
    const [approval, run, recipient, turn] = await Promise.all([
      db.approval.findUnique({ where: { id: request.approvalId! }, select: { status: true } }),
      db.session.findUnique({ where: { id: request.fromSessionId }, select: { task: { select: { project: true } } } }),
      db.session.findUnique({ where: { id: request.toSessionId }, select: COORDINATOR_PAUSE_SELECT }),
      db.conversationTurn.findUnique({ where: { id: request.turnId }, select: { status: true, deliveredAt: true } }),
    ]);
    const project = run?.task?.project;
    result.set(request.approvalId!, runItemHold({
      kind: 'QUESTION', project: { automatic: true, coordinatorEnabled: project?.coordinatorEnabled ?? false },
      coordinatorSessionId: project?.coordinatorSessionId ?? null,
      coordinatorSession: project?.coordinatorSessionId === request.toSessionId ? recipient : null,
      answered: request.state === 'REPLIED' || request.state === 'OWNER_ANSWERED' || approval?.status !== 'PENDING',
      delivery: 'DELIVERED', deliveryRefusal: null, deliveredTurn: turn,
      stoppedWithoutAnswer: ['NO_REPLY', 'UNDELIVERED'].includes(request.state), dueAt: request.replyBy,
    }, now));
  }
  return result;
}

export async function visibleQuestions<T extends { id: string; toolName?: string }>(db: Db, approvals: T[]): Promise<T[]> {
  const holds = await questionHolds(db, approvals.filter(a => a.toolName === 'AskUserQuestion').map(a => a.id));
  return approvals.filter(a => holds.get(a.id)?.place !== 'HELD').map(a => {
    const hold = holds.get(a.id);
    return hold?.place === 'FALLBACK' ? { ...a, coordinatorFallback: hold.reason } : a;
  });
}

export interface QuestionAnswer { question: number; option?: number; options?: number[]; text?: string }
export interface QuestionReply { message?: string | null; option?: number | null; answers?: QuestionAnswer[] }

/** Preserve the engine's existing question-text → labels/words wire format. */
export function questionAnswers(input: unknown, reply: QuestionReply): { answers: Record<string, string[]>; text: string } {
  const questions = (input as { questions?: Array<{ question: string; options?: Array<{ label: string }>; multiSelect?: boolean }> }).questions;
  const bad = (): never => { throw new BadRequestException('answer each question exactly once with option, options (multiple choice), or text'); };
  if (!Array.isArray(questions) || !questions.length) return bad();
  const given = reply.answers ?? (questions.length === 1 ? [{ question: 0, ...(reply.option != null ? { option: reply.option } : { text: reply.message ?? '' }) }] : []);
  if (!Array.isArray(given) || given.length !== questions.length) return bad();
  const answers: Record<string, string[]> = {};
  const seen = new Set<number>();
  for (const answer of given) {
    if (!answer || !Number.isInteger(answer.question) || seen.has(answer.question)) return bad();
    const q = questions[answer.question];
    if (!q || [answer.option != null, answer.options != null, answer.text != null].filter(Boolean).length !== 1) return bad();
    seen.add(answer.question);
    let value: string[];
    if (answer.text != null) {
      if (typeof answer.text !== 'string' || !answer.text.trim()) return bad();
      value = [answer.text.trim()];
    } else {
      const indices = answer.options ?? [answer.option!];
      if (!Array.isArray(indices) || !indices.length || (answer.options && !q.multiSelect) || new Set(indices).size !== indices.length) return bad();
      value = indices.map(i => {
        if (!Number.isInteger(i) || !q.options?.[i]) return bad();
        return q.options[i].label;
      });
    }
    answers[q.question] = value;
  }
  return { answers, text: Object.entries(answers).map(([q, a]) => `${q}: ${a.join(', ')}`).join('\n') };
}

export async function appendRunQuestionContext(db: Db, key: string, content: string | null | undefined) {
  const approvalId = questionApprovalId(key);
  if (!approvalId) return content;
  const request = await db.sessionRequest.findFirst({ where: { approvalId, kind: 'RUN_QUESTION' } });
  const approval = await db.approval.findUnique({ where: { id: approvalId } });
  if (!request || !approval) return content;
  const run = await db.session.findUnique({ where: { id: request.fromSessionId }, select: { taskId: true, task: { select: { title: true } } } });
  const sender = await readBlockSender(db, request.ownerId, request.fromSessionId, request.toSessionId);
  const questions = (approval.input as { questions?: Array<{ question: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }> }).questions ?? [];
  const questionText = questions.map((q, i) => `Question ${i + 1} (${q.multiSelect ? 'any of' : 'one of'}): ${q.question}\n`
    + (q.options ?? []).map((o, j) => `  ${j}. ${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n')).join('\n');
  const open = request.state === 'OPEN' && approval.status === 'PENDING';
  const block = `<orbit-run-question task="${run?.taskId ? uuidToBase62(run.taskId) : ''}" run-session="${uuidToBase62(request.fromSessionId)}" request-id="${uuidToBase62(request.id)}" reply-by="${request.replyBy.toISOString()}" ${sender?.attributes.join(' ') ?? ''}>\n`
    + (open ? `A run of the task “${attribute(run?.task?.title ?? '')}” asked a question meant for a person and is blocked until it is answered.\nThe account owner has not been asked.\n${sender?.lines.join('\n') ?? ''}\nQuestions (use zero-based question and option indices in answers):\n${questionText}\nAnswer with session_reply(requestId="${uuidToBase62(request.id)}", answers=[{question: 0, option: 1}]); use text instead of option for your own words. If the decision is the owner's, call ask_owner with your recommendation and forRunQuestion="${uuidToBase62(request.id)}", then answer here once they have told you. If you do neither by reply-by, or stop without answering, Orbit asks the owner directly and says you did not review it.`
      : `This question is ${request.state}; approval is ${approval.status}. Nothing to answer; end your turn.`)
    + '\n</orbit-run-question>';
  return content ? `${content}\n\n${block}` : block;
}

/** A run row explains its blocked question without counting it as an owner decision. */
export async function questionsWithCoordinator(db: Db, sessionIds: string[]) {
  const result = new Map<string, { count: number; since: string; dueAt: string }>();
  if (!sessionIds.length) return result;
  const approvals = await db.approval.findMany({ where: {
    sessionId: { in: sessionIds }, toolName: 'AskUserQuestion', status: 'PENDING',
  }, select: { id: true, sessionId: true, createdAt: true } });
  const holds = await questionHolds(db, approvals.map(a => a.id));
  for (const approval of approvals) {
    const hold = holds.get(approval.id);
    if (hold?.place !== 'HELD') continue;
    const prior = result.get(approval.sessionId);
    result.set(approval.sessionId, {
      count: (prior?.count ?? 0) + 1,
      since: prior && prior.since < approval.createdAt.toISOString() ? prior.since : approval.createdAt.toISOString(),
      dueAt: prior && prior.dueAt < hold.dueAt.toISOString() ? prior.dueAt : hold.dueAt.toISOString(),
    });
  }
  return result;
}

export async function readRunQuestionCard(db: Db, key: string) {
  const approvalId = questionApprovalId(key);
  if (!approvalId) return null;
  const request = await db.sessionRequest.findFirst({ where: { kind: 'RUN_QUESTION', approvalId } });
  const approval = await db.approval.findUnique({ where: { id: approvalId } });
  if (!request || !approval) return null;
  const run = await db.session.findUnique({ where: { id: request.fromSessionId }, select: { taskId: true, task: { select: { title: true } } } });
  return { requestId: request.id, approvalId, taskId: run?.taskId ?? null, taskTitle: run?.task?.title ?? '',
    runSessionId: request.fromSessionId, replyBy: request.replyBy.toISOString(), state: request.state,
    questions: (approval.input as Prisma.JsonObject).questions ?? [], approvalStatus: approval.status };
}
