import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectIntegrationView } from '@orbit/shared';
import { api } from '../api';
import { projectIntegrationQuery } from '../lib/queries';
import { LandingLink, LandingNoPage } from './LandingLink';
import {
  LANDING_ALL_JOBS,
  LANDING_NOTHING_TO_DO,
  LANDING_WORDS,
  LandingHead,
  landingHead,
  landingOnto,
  type LandingCard,
} from './ProjectPanoramaHeader';

/**
 * The landing in flight, as a card of its own (owner decision 2026-10-11, mocks in
 * docs/mocks/project-landing-card): the merge card's shape — `.session-project-merge` is the same
 * border, radius and wash — for the job that lands a task on the project branch. Drawn under the
 * progress card on the project's sessions page and inside the Work overview card on the project
 * page, from the card model `landingCard` builds; iOS draws the same card from the same read.
 *
 * Head: the merged line's own anatomy (owner decision 2026-10-11, board
 * docs/mocks/project-merge-check-row) — the 28px circle with the ring (spinning while the job runs,
 * still while it waits its turn, a triangle when the server judged its runner silent;
 * `prefers-reduced-motion` stops the spin and nothing else), the word, the live clock at the right
 * of it, and the state, the wait and the freshness in one line under both. Body: what is landing —
 * the task's title, or one row per job with each one's own state — and the branch it lands on.
 *
 * The way into a landing session is said in words rather than folded into a press (owner
 * 2026-10-19, 方案 A, board v4 04): one job gets one "Open landing ›" at the card's foot, beside
 * Retry; several get one each at the end of their row, and the row of a merge into main gets none —
 * that round's way in is the merge card. Because the card is one `<button>`, those rows and links
 * are its SIBLINGS: a link inside a button is not a link. The press itself is unchanged — it opens
 * the jobs in flight.
 *
 * Read-only apart from Retry, which is the Jobs list's own door
 * (`POST /projects/:id/integration/jobs/:jobId/retry`) and appears only where the server says a
 * retry takes the job (`retryable`, never `timedOut`). A press opens the jobs in flight.
 */
export function ProjectLandingCard({
  projectId,
  card,
  onPress,
  dialog = false,
}: {
  projectId: string;
  card: LandingCard;
  /** Opens the jobs in flight, in a dialog or as the page it belongs to. Absent from a page with
   *  nothing to open: the card is then read, not pressed. */
  onPress?: () => void;
  /** Whether that press opens the jobs list rather than a page — and so whether the card offers
   *  the card's own way in beside Retry. */
  dialog?: boolean;
}): JSX.Element {
  // Which half of the wait the card is in, and whether it is the one that wants a person. The
  // classes carry the whole of it: the words next to the mark say the same thing without colour.
  const shape = card.timedOut ? ' is-timed-out' : card.running ? ' is-running' : '';
  const several = card.jobs.length > 1;
  // A card holding one job: the single row IS that job, so its way in is the card's foot.
  const lead = several ? null : card.jobs[0] ?? null;
  // What the card says inside its press. A card of several jobs keeps only the head here: its rows
  // are siblings of the press (their links may not live inside a button), and so are the branch and
  // the sentence under them.
  const body = (
    <>
      <LandingHead title={card.title} head={landingHead(card)} running={card.running}
        timedOut={card.timedOut} />
      {!several && card.what ? <span className="spl-what">{card.what}</span> : null}
      {!several && card.target ? <span className="spl-ref">{landingOnto(card.target)}</span> : null}
      {!several && (card.timedOut
        ? (card.detail ? <span className="spl-det">{card.detail}</span> : null)
        : <span className="spl-note">{LANDING_NOTHING_TO_DO}</span>)}
    </>
  );
  const press = onPress ? (
    <button type="button" className="spl-press" aria-haspopup={dialog ? 'dialog' : undefined}
      onClick={onPress}>
      {body}
    </button>
  ) : (
    <div className="spl-press">{body}</div>
  );
  return (
    <div className={`session-project-landing${shape}`}>
      {press}
      {/* Several jobs: a row each, its link beside it and outside the press — a link may not be
          inside a button, and the row that lands no task is the merge card's to open. */}
      {several ? (
        <ul className="spl-jobs">
          {card.jobs.map((job) => (
            <li key={job.jobId}>
              <span>{job.title}</span>
              <span className={job.running ? 'st run' : 'st'}>{job.state}</span>
              {job.mergeJob ? null : job.landingSessionId ? (
                <LandingLink className="spl-open" sessionId={job.landingSessionId} />
              ) : (
                <LandingNoPage className="spl-open is-none" />
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {several && card.target ? <span className="spl-ref">{landingOnto(card.target)}</span> : null}
      {several ? (card.timedOut
        ? (card.detail ? <span className="spl-det">{card.detail}</span> : null)
        : <span className="spl-note">{LANDING_NOTHING_TO_DO}</span>) : null}
      {/* Mounted only where it draws: a card with no Retry, no job to open and no list to open
          holds no mutation and reads no query client. */}
      {card.retryJobId !== null || dialog || lead !== null ? (
        <LandingFoot projectId={projectId} card={card} dialog={dialog} onAllJobs={onPress} lead={lead} />
      ) : null}
    </div>
  );
}

/**
 * The card's foot: Retry where the server takes one, the one job's way into its landing, and the
 * way into the jobs beside them — all in one row, and all siblings of the card's own press.
 *
 * Pure: the only mutation it holds is Retry's, mounted with the button (`RetryPress`), so a card
 * whose server takes no retry reads no query client at all. A card holding several jobs gets no
 * foot slot for a landing — each row carries its own — and a server that names no landing session
 * for the one job gets the grey sentence in the same slot rather than a link to nowhere.
 */
function LandingFoot({
  projectId,
  card,
  dialog,
  onAllJobs,
  lead,
}: {
  projectId: string;
  card: LandingCard;
  dialog: boolean;
  onAllJobs?: () => void;
  lead: LandingCard['jobs'][number] | null;
}): JSX.Element {
  return (
    <div className="spl-foot">
      {card.retryJobId ? <RetryPress projectId={projectId} jobId={card.retryJobId} /> : null}
      {lead ? (
        lead.landingSessionId
          ? <LandingLink className="spl-open" sessionId={lead.landingSessionId} />
          : <LandingNoPage className="spl-open is-none" />
      ) : null}
      <span className="spl-spacer" />
      {dialog && onAllJobs ? (
        <button type="button" className="spl-link" onClick={onAllJobs}>
          {`${LANDING_ALL_JOBS} ›`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Retry through the jobs list's own door, and the server's refusal said under it. Mounted only
 * where the server says a retry takes the job, so a card that draws no Retry holds no mutation.
 */
function RetryPress({ projectId, jobId }: { projectId: string; jobId: string }): JSX.Element {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryJob(projectId, jobId),
    // The answer is the fresh view, so the card redraws from it at once: the timed-out generation
    // gone, and the new one in its place — the jobs list's own handling, by the same door.
    onSuccess: (view) => {
      qc.setQueryData(projectIntegrationQuery(projectId).queryKey, view);
    },
    // Not awaited: a refusal is shown as soon as it arrives, not once every read has come round.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
  return (
    <>
      <button type="button" className="spl-primary" disabled={retry.isPending} onClick={() => retry.mutate()}>
        {LANDING_WORDS.RETRY}
      </button>
      {retry.isError ? (
        <div className="spl-error" role="alert">
          {/* The server's sentence ends with its own full stop; this line supplies one. */}
          {`${LANDING_WORDS.RETRY_FAILED} — ${retry.error.message.replace(/[.\s]+$/, '')}.`}
        </div>
      ) : null}
    </>
  );
}

/** Retry through the jobs list's own door — one address for the card and the row. */
export function retryJob(projectId: string, jobId: string): Promise<ProjectIntegrationView> {
  return api<ProjectIntegrationView>(
    `/projects/${encodeURIComponent(projectId)}/integration/jobs/${encodeURIComponent(jobId)}/retry`,
    { method: 'POST' },
  );
}
