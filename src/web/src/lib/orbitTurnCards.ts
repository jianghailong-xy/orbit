import type {
  EvidenceReviewCard,
  EvidenceSendBackCard,
  RunNoticeCard,
  RunQuestionCard,
  SessionOpeningCard,
} from '@orbit/shared';

/**
 * The readings the control plane records beside five more of its own turns
 * (docs/mocks/orbit-turn-cards/): a revision handed to the session that dispatched its task, a
 * send-back's note handed to the run, a task run's question and its notify handed to the coordinator,
 * and the opening of a session Orbit opened. Read the way the confirmation-review cards are
 * (lib/confirmationReviewTurns): the shape is checked, and a payload that is not one parses as NOTHING
 * rather than as half a card.
 */

type Raw = Record<string, unknown>;

function field(payload: unknown, name: string): Raw | null {
  const raw = (payload as Raw | null)?.[name];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Raw : null;
}

const str = (value: unknown): value is string => typeof value === 'string';
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function parseEvidenceReview(payload: unknown): EvidenceReviewCard | null {
  const card = field(payload, 'evidenceReview');
  if (!card || !str(card.taskId) || card.taskId === '' || !str(card.title) || !str(card.revision)) return null;
  const state = card.state;
  if (state !== 'OPEN' && state !== 'SUPERSEDED' && state !== 'DECIDED' && state !== 'CLOSED') return null;
  const decision = card.decision === 'CONFIRM' || card.decision === 'SEND_BACK' ? card.decision : null;
  return {
    evidenceId: str(card.evidenceId) ? card.evidenceId : '',
    taskId: card.taskId,
    title: card.title,
    revision: card.revision,
    runSessionId: str(card.runSessionId) ? card.runSessionId : '',
    dueAt: strOrNull(card.dueAt),
    claim: strOrNull(card.claim),
    state,
    latestRevision: str(card.latestRevision) ? card.latestRevision : card.revision,
    decision,
  };
}

export function parseEvidenceSendBack(payload: unknown): EvidenceSendBackCard | null {
  const card = field(payload, 'evidenceSendBack');
  if (!card || !str(card.taskId) || card.taskId === '' || !str(card.title) || !str(card.revision) || !str(card.note)) {
    return null;
  }
  if (card.by !== 'OWNER' && card.by !== 'SESSION') return null;
  return {
    decisionId: str(card.decisionId) ? card.decisionId : '',
    taskId: card.taskId,
    title: card.title,
    revision: card.revision,
    note: card.note,
    by: card.by,
    bySessionId: strOrNull(card.bySessionId),
    byTitle: strOrNull(card.byTitle),
  };
}

export function parseRunQuestion(payload: unknown): RunQuestionCard | null {
  const card = field(payload, 'runQuestion');
  if (!card || !str(card.requestId) || !str(card.replyBy) || !str(card.state) || !Array.isArray(card.questions)) return null;
  const questions = card.questions.flatMap((value): RunQuestionCard['questions'] => {
    if (!value || typeof value !== 'object') return [];
    const q = value as Raw;
    if (!str(q.question)) return [];
    const options = Array.isArray(q.options)
      ? q.options.flatMap((o) => (o && typeof o === 'object' && str((o as Raw).label)
        ? [{ label: (o as Raw).label as string, ...(str((o as Raw).description) ? { description: (o as Raw).description as string } : {}) }]
        : []))
      : [];
    return [{ question: q.question, ...(q.multiSelect === true ? { multiSelect: true } : {}), options }];
  });
  if (questions.length === 0) return null;
  const answers = card.answers && typeof card.answers === 'object' && !Array.isArray(card.answers)
    ? Object.fromEntries(Object.entries(card.answers as Raw)
      .map(([key, value]) => [key, Array.isArray(value) ? value.filter(str) : str(value) ? [value] : []]))
    : null;
  return {
    requestId: card.requestId,
    approvalId: str(card.approvalId) ? card.approvalId : '',
    taskId: strOrNull(card.taskId),
    taskTitle: str(card.taskTitle) ? card.taskTitle : '',
    runSessionId: str(card.runSessionId) ? card.runSessionId : '',
    replyBy: card.replyBy,
    state: card.state,
    approvalStatus: str(card.approvalStatus) ? card.approvalStatus : '',
    questions,
    answers,
    answeredBy: card.answeredBy === 'SESSION' || card.answeredBy === 'OWNER' ? card.answeredBy : null,
  };
}

export function parseRunNotice(payload: unknown): RunNoticeCard | null {
  const card = field(payload, 'runNotice');
  if (!card || !str(card.requestId) || !str(card.message) || !str(card.state)) return null;
  return {
    requestId: card.requestId,
    taskId: strOrNull(card.taskId),
    taskTitle: str(card.taskTitle) ? card.taskTitle : '',
    runSessionId: str(card.runSessionId) ? card.runSessionId : '',
    message: card.message,
    state: card.state,
  };
}

const OPENING_KINDS = new Set(['COORDINATOR', 'JUDGMENT', 'DISPATCH', 'MENTION', 'OTHER']);
const TARGET_KINDS = new Set(['PROJECT', 'TASK', 'LIST']);

export function parseSessionOpening(payload: unknown): SessionOpeningCard | null {
  const card = field(payload, 'sessionOpening');
  if (!card || !str(card.kind) || !OPENING_KINDS.has(card.kind)) return null;
  const target = field(card, 'target');
  return {
    kind: card.kind as SessionOpeningCard['kind'],
    target: target && str(target.kind) && TARGET_KINDS.has(target.kind) && str(target.id) && str(target.title)
      ? { kind: target.kind as 'PROJECT' | 'TASK' | 'LIST', id: target.id, title: target.title }
      : null,
    mention: strOrNull(card.mention),
  };
}
