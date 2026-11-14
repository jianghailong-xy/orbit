import { useContext, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AimOutlined,
  AuditOutlined,
  BellOutlined,
  QuestionCircleOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import type {
  EvidenceReviewCard,
  EvidenceSendBackCard,
  RunNoticeCard,
  RunQuestionCard,
  SessionOpeningCard,
} from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import { sessionRequestQuery } from '../lib/queries';
import { AppLink } from './AppLink';
import { ExportCtx } from './Transcript';
import { Button } from './ui/Button';
import { decisionReceiptTime } from './EvidenceDecisionCard';
import { OPEN_TASK_SESSION } from './ConfirmationReviewTurnCards';

/**
 * Five more of Orbit's own turns, drawn as what they are rather than as the reader's bubble or an
 * empty bubble with the agent's block folded under it (docs/mocks/orbit-turn-cards/). Built like the
 * confirmation-review cards (ConfirmationReviewTurnCards.tsx): one line saying what happened, links
 * instead of ids, local time, and the block the agent read folded at the foot.
 */

export const EVIDENCE_TO_REVIEW = 'Evidence to review';
export const EVIDENCE_SENT_BACK = 'Evidence sent back';
export const QUESTION_FROM_RUN = 'Question from a task run';
export const NOTICE_FROM_RUN = 'Notice from a task run';
export const SESSION_WAS_TOLD = 'What this session was told';
export const RUN_WAS_TOLD = 'What the run was told';
export const COORDINATOR_WAS_TOLD = 'What the coordinator was told';
export const SHOW_ALL = 'Show all';
export const SHOW_LESS = 'Show less';
export const SHOW_BRIEF = 'Show brief';
export const HIDE_BRIEF = 'Hide brief';
export const TASK_RUN_FALLBACK = 'A task run';
export const UNDELIVERED = 'The session has not confirmed it received this.';
export const NOTICE_STATE = 'Nothing to reply to. It did not reach you.';
export const ANSWERED_BY_SESSION = 'Answered by this session.';
export const ANSWERED_BY_YOU = 'Answered by you.';
export const CLOSED_WITHOUT_ANSWER = 'Closed without an answer.';
export const EVIDENCE_DECIDES = 'This session decides it.';
export const EVIDENCE_CONFIRMED = 'Confirmed.';
export const EVIDENCE_SENT_BACK_STATE = 'Sent back.';
export const EVIDENCE_CLOSED = 'The task is closed. Nothing to decide.';
export const SESSION_STARTED = 'Orbit started this session';

export function evidenceMeta(card: EvidenceReviewCard): string {
  return card.dueAt ? `Revision ${card.revision} · Due ${decisionReceiptTime(card.dueAt)}` : `Revision ${card.revision}`;
}

/** What the card says about who decides, and where it stands, as the rows read now. */
export function evidenceState(card: EvidenceReviewCard, now: Date = new Date()): { text: string; tone?: 'warn' | 'ok' } {
  switch (card.state) {
    case 'SUPERSEDED':
      return { text: `Revision ${card.latestRevision} replaced it. Nothing to decide.` };
    case 'DECIDED':
      return card.decision === 'CONFIRM' ? { text: EVIDENCE_CONFIRMED, tone: 'ok' } : { text: EVIDENCE_SENT_BACK_STATE };
    case 'CLOSED':
      return { text: EVIDENCE_CLOSED };
    default:
      if (!card.dueAt) return { text: EVIDENCE_DECIDES };
      if (now.getTime() >= new Date(card.dueAt).getTime()) {
        return { text: `You were asked at ${decisionReceiptTime(card.dueAt, now)}.`, tone: 'warn' };
      }
      return { text: `${EVIDENCE_DECIDES} If it hasn't by ${decisionReceiptTime(card.dueAt, now)}, you're asked.` };
  }
}

export function sendBackWho(card: EvidenceSendBackCard): { lead: string; name: string; sessionId: string | null } {
  const lead = `Revision ${card.revision} · by `;
  if (card.by === 'OWNER') return { lead, name: 'you', sessionId: null };
  return { lead, name: card.byTitle?.trim() || 'a session', sessionId: card.bySessionId };
}

/** The run question's state line, read from the request and its card as they stand now. */
export function runQuestionState(card: RunQuestionCard, now: Date = new Date()): { text: string; tone?: 'warn' | 'ok' } {
  if (card.answeredBy === 'SESSION') return { text: ANSWERED_BY_SESSION, tone: 'ok' };
  if (card.answeredBy === 'OWNER') return { text: ANSWERED_BY_YOU, tone: 'ok' };
  const due = decisionReceiptTime(card.replyBy, now);
  if (card.state === 'OPEN' && now.getTime() < new Date(card.replyBy).getTime()) {
    return { text: `The run is waiting. This session answers it; if it hasn't by ${due}, you're asked.` };
  }
  if (card.approvalStatus === 'PENDING') return { text: `Passed to you at ${due}.`, tone: 'warn' };
  return { text: CLOSED_WITHOUT_ANSWER };
}

/** The opening line's sentence, before its link. */
export function openingSentence(card: SessionOpeningCard): string {
  if (!card.target) return SESSION_STARTED;
  switch (card.kind) {
    case 'COORDINATOR': return `${SESSION_STARTED} as the coordinator of `;
    case 'JUDGMENT': return `${SESSION_STARTED} to judge `;
    case 'DISPATCH': return `${SESSION_STARTED} to dispatch the list `;
    case 'MENTION': return `${SESSION_STARTED} for your mention on `;
    default: return SESSION_STARTED;
  }
}

function targetHref(target: NonNullable<SessionOpeningCard['target']>): string | null {
  const id = routeId(target.id);
  if (!id) return null;
  const at = encodeURIComponent(id);
  return target.kind === 'PROJECT' ? `/projects/${at}` : target.kind === 'LIST' ? `/lists/${at}` : `/tasks/${at}`;
}

function TaskTitle({ taskId, title }: { taskId: string | null; title: string }) {
  const shown = title.trim() || TASK_RUN_FALLBACK;
  const task = taskId ? routeId(taskId) : null;
  return (
    <div className="crc-title">
      {task ? <AppLink to={`/tasks/${encodeURIComponent(task)}`}>{shown}</AppLink> : shown}
    </div>
  );
}

function OpenTaskSessionPress({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  return (
    <Button size="small" onClick={() => navigate(`/sessions/${encodeURIComponent(sessionId)}`)}>
      {OPEN_TASK_SESSION}
    </Button>
  );
}

/** The way onto the run, a press inside a router and a link without one (the HTML export). */
function OpenTaskSession({ runSessionId }: { runSessionId: string }) {
  const inRouter = useInRouterContext();
  const run = routeId(runSessionId);
  if (!run) return null;
  return (
    <div className="crc-actions">
      {inRouter
        ? <OpenTaskSessionPress sessionId={run} />
        : <AppLink to={`/sessions/${encodeURIComponent(run)}`}>{OPEN_TASK_SESSION}</AppLink>}
    </div>
  );
}

function Told({ label, text }: { label: string; text: string }) {
  if (text.trim() === '') return null;
  return (
    <details className="crc-raw">
      <summary>{label}</summary>
      <pre>{text}</pre>
    </details>
  );
}

function Foot({ undelivered, attached, queued }: { undelivered?: boolean; attached?: ReactNode; queued?: ReactNode }) {
  return (
    <>
      {undelivered && <div className="crc-undelivered">{UNDELIVERED}</div>}
      {attached}
      {queued && <div className="crc-queued">{queued}</div>}
    </>
  );
}

function StateLine({ state }: { state: { text: string; tone?: 'warn' | 'ok' } }) {
  return <div className={`crc-state${state.tone ? ` is-${state.tone}` : ''}`}>{state.text}</div>;
}

function Claim({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split('\n').length > 3;
  return (
    <div className={`crc-claim${long && !open ? ' is-clamped' : ''}`}>
      <div className="crc-claim-text">{text}</div>
      {long && (
        <button type="button" className="crc-more" onClick={() => setOpen(!open)}>
          {open ? SHOW_LESS : SHOW_ALL}
        </button>
      )}
    </div>
  );
}

interface CardProps {
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  /** The block the agent was handed — the turn's own words or its control-plane note. */
  told: string;
  attached?: ReactNode;
  queued?: ReactNode;
}

function Head({ icon, label, ts }: { icon: ReactNode; label: string; ts?: string }) {
  return (
    <div className="crc-head">
      <span className="crc-mark">{icon}</span>
      <span>{label}</span>
      {ts ? <span className="crc-when">{decisionReceiptTime(ts)}</span> : null}
    </div>
  );
}

export function EvidenceToReviewCard({ card, seq, ts, undelivered, told, attached, queued }: CardProps & { card: EvidenceReviewCard }) {
  const open = card.state === 'OPEN';
  return (
    <div className="crc-wrap">
      <div
        className={`crc crc-evidence-review${open ? '' : ' is-neutral'}${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-orbit-round
      >
        <Head icon={<AuditOutlined />} label={EVIDENCE_TO_REVIEW} ts={ts} />
        <TaskTitle taskId={card.taskId} title={card.title} />
        <div className="crc-meta">{evidenceMeta(card)}</div>
        {card.claim?.trim() ? <Claim text={card.claim.trim()} /> : null}
        <StateLine state={evidenceState(card)} />
        {open ? <OpenTaskSession runSessionId={card.runSessionId} /> : null}
        <Told label={SESSION_WAS_TOLD} text={told} />
        <Foot undelivered={undelivered} attached={attached} queued={queued} />
      </div>
    </div>
  );
}

export function EvidenceSentBackCard({ card, seq, ts, undelivered, told, attached, queued }: CardProps & { card: EvidenceSendBackCard }) {
  const who = sendBackWho(card);
  const session = who.sessionId ? routeId(who.sessionId) : null;
  return (
    <div className="crc-wrap">
      <div
        className={`crc crc-evidence-send-back is-returned${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-orbit-round
      >
        <Head icon={<RollbackOutlined />} label={EVIDENCE_SENT_BACK} ts={ts} />
        <TaskTitle taskId={card.taskId} title={card.title} />
        <div className="crc-meta">
          {who.lead}
          {session ? <AppLink to={`/sessions/${encodeURIComponent(session)}`}>{who.name}</AppLink> : who.name}
        </div>
        {card.note.trim() !== '' ? <div className="crc-quote">{`“${card.note.trim()}”`}</div> : null}
        <Told label={RUN_WAS_TOLD} text={told} />
        <Foot undelivered={undelivered} attached={attached} queued={queued} />
      </div>
    </div>
  );
}

export function RunQuestionTurnCard({ card: stored, seq, ts, undelivered, told, attached, queued }: CardProps & { card: RunQuestionCard }) {
  // The card the echo carries was read when the turn was handed out, before anyone answered. Its
  // request carries the card as it stands now (`SessionRequestView.runQuestion`), so that one is
  // drawn over it: answered, by whom, or passed to the owner. Not read on paper, and not once the
  // stored card already says who answered — that never changes.
  const exporting = useContext(ExportCtx) != null;
  const live = useQuery({
    ...sessionRequestQuery(stored.requestId),
    enabled: !exporting && stored.answeredBy === null,
  }).data?.runQuestion;
  const card = live ?? stored;
  const answered = card.answeredBy !== null;
  return (
    <div className="crc-wrap">
      <div
        className={`crc crc-run-question${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-orbit-round
      >
        <Head icon={<QuestionCircleOutlined />} label={QUESTION_FROM_RUN} ts={ts} />
        <TaskTitle taskId={card.taskId} title={card.taskTitle} />
        {card.questions.map((question, index) => {
          const picked = card.answers?.[question.question] ?? [];
          const labels = new Set((question.options ?? []).map((option) => option.label));
          const ownWords = picked.filter((value) => !labels.has(value));
          return (
            <div className="crc-question" key={index}>
              <div className="crc-question-text">{question.question}</div>
              <ul>
                {(question.options ?? []).map((option) => (
                  <li key={option.label} className={picked.includes(option.label) ? 'is-picked' : undefined}>
                    {picked.includes(option.label) ? `✓ ${option.label}` : option.label}
                  </li>
                ))}
                {ownWords.map((words) => <li key={`own:${words}`} className="is-picked">{`✓ “${words}”`}</li>)}
              </ul>
            </div>
          );
        })}
        <StateLine state={runQuestionState(card)} />
        {!answered ? <OpenTaskSession runSessionId={card.runSessionId} /> : null}
        <Told label={COORDINATOR_WAS_TOLD} text={told} />
        <Foot undelivered={undelivered} attached={attached} queued={queued} />
      </div>
    </div>
  );
}

export function RunNoticeTurnCard({ card, seq, ts, undelivered, told, attached, queued }: CardProps & { card: RunNoticeCard }) {
  return (
    <div className="crc-wrap">
      <div
        className={`crc crc-run-notice is-neutral${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-orbit-round
      >
        <Head icon={<BellOutlined />} label={NOTICE_FROM_RUN} ts={ts} />
        <TaskTitle taskId={card.taskId} title={card.taskTitle} />
        {card.message.trim() !== '' ? <div className="crc-quote">{`“${card.message.trim()}”`}</div> : null}
        <StateLine state={{ text: NOTICE_STATE }} />
        <Told label={COORDINATOR_WAS_TOLD} text={told} />
        <Foot undelivered={undelivered} attached={attached} queued={queued} />
      </div>
    </div>
  );
}

/** A session's opening Orbit wrote: one line saying why, the brief folded under it. */
export function SessionOpeningLine({
  card,
  brief,
  seq,
  attached,
}: {
  card: SessionOpeningCard;
  brief: string;
  seq?: number;
  attached?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const href = card.target ? targetHref(card.target) : null;
  const sentence = openingSentence(card);
  return (
    <div className="session-opening" data-seq={seq}>
      <div className="session-opening-line">
        <span className="session-opening-mark"><AimOutlined /></span>
        <span className="session-opening-text">
          {sentence}
          {card.target && sentence !== SESSION_STARTED
            ? (href ? <AppLink to={href}>{card.target.title}</AppLink> : card.target.title)
            : null}
        </span>
        {brief.trim() !== '' && (
          <button type="button" className="session-opening-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? `${HIDE_BRIEF} ▾` : `${SHOW_BRIEF} ▸`}
          </button>
        )}
      </div>
      {card.kind === 'MENTION' && card.mention?.trim()
        ? <div className="session-opening-quote">{`“${card.mention.trim()}”`}</div>
        : null}
      {open && <pre className="session-opening-brief">{brief}</pre>}
      {attached}
    </div>
  );
}
