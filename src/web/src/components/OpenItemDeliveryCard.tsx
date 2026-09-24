import { useState, type ReactNode } from 'react';
import { CheckCircleFilled, ExclamationCircleFilled } from '@ant-design/icons';
import type { OpenItemAction, OpenItemDeliveryCard as Delivery, OpenItemKind } from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import { AppLink } from './AppLink';
import { relTime } from './Transcript';

/**
 * An exception item's delivery to the coordinator, drawn as the card it already was in every other
 * surface — instead of 30 lines of prose inside the reader's own bubble.
 *
 * The prose is written for the AGENT: it names the tools to call and the ids to call them with, and
 * it says out loud that the platform will not retry. A person watching the conversation gets none
 * of that from a card, so this draws what the payload records (`OpenItemDeliveryCard`, read by
 * lib/openItemDelivery): what kind of item it is, what it is about, the facts the item was opened
 * with — the files a merge conflicted on, the check that disagreed, the attempt that failed — the
 * doors the coordinator has on it, and the one thing the platform already knows and the coordinator
 * otherwise re-checks by hand every time: whether the work is on the target branch.
 *
 * The words the agent read are not thrown away — they are one disclosure away at the bottom, which
 * is also where a reader finds the instruction this card deliberately does not repeat.
 */

/** How many conflicting files the card lists before folding the rest away. */
const FILES_SHOWN = 3;

const KIND_LABEL: Record<OpenItemKind, string> = {
  INTEGRATION_CONFLICT: 'Merge conflict',
  INTEGRATION_CHECK_FAILED: 'Checks failed',
  INTEGRATION_ERROR: 'Integration error',
  TASK_FAILED: 'Task failed',
  PROMOTION_APPROVAL: 'Merge approval',
  COORDINATOR_QUESTION: 'Question',
  FUSE_PAUSED: 'Project paused',
};

/**
 * What each door is called on the card. `OPEN_COORDINATOR` and `OPEN_TASK_SESSION` are absent on
 * purpose: the first is the conversation this card is drawn in — a link to where the reader already
 * is — and the second is a link, drawn below as one.
 */
const ACTION_LABEL: Partial<Record<OpenItemAction, string>> = {
  RETRY: 'Retry the task',
  CANCEL_TASK: 'Cancel the task',
  ASK_COORDINATOR_AGAIN: 'Ask the coordinator again',
  REVIEW: 'Review the merge',
  ANSWER: 'Answer the question',
  RESUME: 'Resume the project',
};

/** Why an attempt failed, in the words a reader acts on. */
function howInEnglish(how: string | null): string {
  switch (how) {
    case 'ACCEPTANCE_EXIT_MISMATCH':
      return 'The acceptance command disagreed with what the task declared';
    case 'RUN_FAILED':
      return 'A turn of the run failed';
    case 'RUNNER_FINALIZED_FAILED':
      return 'The runner finished the run as failed';
    case 'REAPED_API_ERROR':
      return 'The run stopped on an API or sign-in error and was reaped';
    case 'ATTEMPT_LOST_RUNNER_OFFLINE':
      return 'Its runner went offline and the attempt was taken back';
    case 'ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED':
      return 'Its runtime never started and the attempt was taken back';
    case 'REPORTED_FAILED':
      return 'Somebody filed it as failed';
    default:
      return 'The task failed';
  }
}

/** The one line that says what happened, out of the kind's own fields. */
function headline(card: Delivery): string | null {
  const target = card.targetRef ? ` into ${card.targetRef}` : '';
  if (card.kind === 'TASK_FAILED' && card.failure) {
    const exit = card.failure.exitCode !== null
      ? ` — exit ${card.failure.exitCode}, expected ${card.failure.expectedExitCode ?? 0}`
      : '';
    return `${howInEnglish(card.failure.how)}${exit} · attempt ${card.failure.attempt} of `
      + `${card.failure.limit} in this chain.`;
  }
  if (card.kind === 'INTEGRATION_CONFLICT') {
    return `git refused the merge${target}; the target branch did not move. `
      + 'The platform will not retry it by itself.';
  }
  if (card.kind === 'INTEGRATION_CHECK_FAILED' && card.check) {
    return `Check ${card.check.name} exited ${card.check.exitCode ?? '?'} where `
      + `${card.check.expectedExitCode ?? '?'} was declared; the target branch did not move.`;
  }
  if (card.kind === 'INTEGRATION_ERROR') {
    return `The integration job ended with ${card.errorCode ?? 'an error'}`
      + `${target}; the target branch did not move.`;
  }
  return null;
}

/**
 * What the platform already knew about the work when it handed the item over — the fact that used
 * to cost the coordinator a re-check of the merge receipts every single time an item came round.
 *
 * `NOT_KNOWN` is said as what it is: no receipt is no EVIDENCE, never "it did not land", because
 * work lands by paths that leave no row behind and a card that denied one would send a reader
 * looking for a merge that already happened.
 */
function landingLine(card: Delivery): { text: string; tone: 'landed' | 'unknown' } | null {
  const landing = card.landing;
  if (!landing) return null;
  if (landing.state === 'ON_UPSTREAM') {
    return {
      tone: 'landed',
      text: `Already on ${landing.upstream} — a merge receipt records this work there.`,
    };
  }
  if (landing.state === 'ON_INTEGRATION_LINE') {
    return {
      tone: 'landed',
      text: `On ${landing.integration}, not yet on ${landing.upstream} — a merge receipt records it `
        + 'on the project branch.',
    };
  }
  const receipts = landing.receipts;
  return {
    tone: 'unknown',
    text: receipts === 0
      ? 'No merge receipt for this work — Orbit cannot tell whether it has landed.'
      : `${receipts} merge receipt${receipts === 1 ? '' : 's'}, none naming ${landing.upstream} — `
        + 'Orbit cannot tell whether this work has landed.',
  };
}

export function OpenItemDeliveryCard({
  card,
  text,
  seq,
  ts,
  undelivered,
  queued,
}: {
  card: Delivery;
  /** The words the agent was handed, verbatim — the record this card is drawn from. */
  text: string;
  /** Unset while the delivery is still queued: it is no event yet, so ⌘F has nothing to land on. */
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  /** The queued tail's status line, while the delivery still waits behind the running turn. */
  queued?: ReactNode;
}) {
  const [allFiles, setAllFiles] = useState(false);
  const files = allFiles ? card.files : card.files.slice(0, FILES_SHOWN);
  const label = KIND_LABEL[card.kind] ?? 'Exception item';
  // The line under the bar's label: the kind, then the item's own title — unless the title already
  // opens with the kind, and then the bar read it twice ("Task failed: Task failed: [WARC]…", the
  // account owner's screenshot, 2026-09-22). A title that says it already wins: it is the server's
  // own sentence about this item. `OpenItemDeliveryCard.stickyText` is the same rule on the native
  // end, and the two ends must stamp the same pair — a bar that dropped half of it on one client
  // would be a second wording of one turn.
  const stickyText = card.title.toLowerCase().startsWith(label.toLowerCase())
    ? card.title
    : `${label}: ${card.title}`;
  const why = headline(card);
  const landing = landingLine(card);
  const chips = card.actions
    .map((action) => ACTION_LABEL[action])
    .filter((text): text is string => text != null);
  // The ids come out of a payload read defensively, so they go through the normalizing codec that
  // degrades on a spelling it does not know instead of the one that throws — a card must not be
  // able to take the transcript down with it.
  const taskPublic = card.task ? routeId(card.task.id) : null;
  const sessionPublic = routeId(card.task?.sessionId);
  const taskHref = taskPublic ? `/tasks/${encodeURIComponent(taskPublic)}` : null;
  const sessionHref = sessionPublic ? `/sessions/${encodeURIComponent(sessionPublic)}` : null;
  return (
    <div className="oic-wrap">
      {/* The sticky bar at the top of the transcript names this turn off these two attributes: it
          scans for user bubbles and would otherwise skip a delivery that is nobody's message (naming
          an earlier question instead, and scrolling to it). */}
      <div
        className={`oic${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-sticky-label="Exception item"
        data-sticky-text={stickyText}
      >
        <div className="oic-head">
          <span className="oic-mark"><ExclamationCircleFilled /></span>
          <span>Exception item</span>
          <span className="oic-kind">{label}</span>
        </div>
        <div className="oic-title">{card.title}</div>
        {card.task && taskHref && (
          <div className="oic-where">
            Task <AppLink to={taskHref}>{card.task.title}</AppLink>
          </div>
        )}
        {why && <div className="oic-why">{why}</div>}
        {card.files.length > 0 && (
          <>
            <ul className="oic-files">
              {files.map((file) => <li key={file}>{file}</li>)}
            </ul>
            {card.files.length > FILES_SHOWN && (
              <button className="oic-more" onClick={() => setAllFiles(!allFiles)}>
                {allFiles ? 'Show fewer files' : `Show ${card.files.length - FILES_SHOWN} more files`}
              </button>
            )}
          </>
        )}
        {landing && (
          <div className={`oic-facts is-${landing.tone}`}>
            <span className="oic-facts-mark">
              {landing.tone === 'landed' ? <CheckCircleFilled /> : '◌'}
            </span>
            <span>{landing.text}</span>
          </div>
        )}
        {chips.length > 0 && (
          <div className="oic-actions">
            <span className="oic-actions-label">The coordinator can:</span>
            {chips.map((chip) => <span className="oic-chip" key={chip}>{chip}</span>)}
          </div>
        )}
        {(taskHref || sessionHref) && (
          <div className="oic-links">
            {taskHref && <AppLink to={taskHref}>Open the task ↗</AppLink>}
            {sessionHref && <AppLink to={sessionHref}>Open the failed session ↗</AppLink>}
          </div>
        )}
        <div className="oic-meta">
          Item {routeId(card.itemId)} · a notification, not an interruption
          {ts ? ` · ${relTime(ts)}` : ''}
        </div>
        {undelivered && (
          <div className="oic-undelivered">The session has not confirmed it received this.</div>
        )}
        <details className="oic-raw">
          <summary>What the coordinator was told</summary>
          <pre>{text}</pre>
        </details>
        {queued && <div className="oic-queued">{queued}</div>}
      </div>
    </div>
  );
}
