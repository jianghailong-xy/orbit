import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RightOutlined } from '@ant-design/icons';
import type { ProjectIntegrationView } from '@orbit/shared';
import { api } from '../api';
import { projectIntegrationQuery } from '../lib/queries';
import { LandingLink, LandingNoPage } from './LandingLink';
import { useIsMobile } from '../lib/useMediaQuery';
import {
  LANDING_WORDS,
  LandingHead,
  landingHead,
  landingJobLines,
  landingJobsTitle,
  type LandingJobLine,
} from './ProjectPanoramaHeader';
import { ProjectTaskLink } from './ProjectTaskLink';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Drawer } from './ui/Drawer';

/**
 * Every integration job in flight, one row each (docs/mocks/landing-jobs-sheet): what the landing
 * row's "2 jobs" counts, opened by pressing that row — on the project's sessions page, on its merge
 * card, and in the project page's Work overview.
 *
 * Each row IS the landing row, from the same read and in the same words, and the first is the job
 * the row outside describes. A task's row opens the task; a promotion or a merge check lands no
 * single task, so its row is not a press. A job the server judged timed out says where its runner
 * stopped, and offers Retry when the server says a retry takes it (`retryable`, never `timedOut`).
 *
 * A sheet from the bottom on a narrow screen and a dialog on a wide one, as the start card opens.
 */
export function LandingJobsSheet({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const narrow = useIsMobile();
  // The read every entry point already holds: one query key, so opening the list is no request.
  const integration = useQuery(projectIntegrationQuery(projectId));
  // The clocks count in seconds while the list is open, as the row's own do.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [open]);
  const view = integration.data ?? null;
  const jobs = view
    ? landingJobLines(view, now, { updatedAt: integration.dataUpdatedAt, failed: integration.isError })
    : [];
  const title = landingJobsTitle(jobs.length);
  // Drawn only while the sheet is (the overlay mounts nothing closed), and kept through its exit.
  const list = jobs.length > 0 ? (
    <ul className="landing-jobs">
      {jobs.map((job) => (
        <LandingJobRow key={job.jobId} projectId={projectId} job={job} onOpenTask={onClose} />
      ))}
    </ul>
  ) : null;
  return narrow ? (
    <Drawer open={open} onClose={onClose} title={title} placement="bottom" height="auto"
      className="landing-jobs-sheet">
      {list}
    </Drawer>
  ) : (
    <Dialog open={open} onClose={onClose} title={title} width={480} className="landing-jobs-dialog">
      {list}
    </Dialog>
  );
}

/**
 * One job: its landing row — a link to its task when it lands one — what happened to it, and Retry
 * when the server takes one. The link and the button are siblings, never one inside the other.
 */
function LandingJobRow({
  projectId,
  job,
  onOpenTask,
}: {
  projectId: string;
  job: LandingJobLine;
  /** Told when the task opens, so the list does not stay over the page the task opens on. */
  onOpenTask: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () =>
      api<ProjectIntegrationView>(
        `/projects/${encodeURIComponent(projectId)}/integration/jobs/${encodeURIComponent(job.jobId)}/retry`,
        { method: 'POST' },
      ),
    // The answer is the fresh view, so the list redraws from it at once: the timed-out generation
    // gone, and the new one in its place.
    onSuccess: (view) => {
      qc.setQueryData(projectIntegrationQuery(projectId).queryKey, view);
    },
    // Not awaited: a refusal is shown as soon as it arrives, not once every read has come round.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
  // The row wears the merged line's head, like every other landing row (owner decision 2026-10-11,
  // board docs/mocks/project-merge-check-row): the mark, the word, the live clock, and the state,
  // the wait and the freshness in one line under both — then the task it lands.
  const body = (
    <div className="landing-jobs-body">
      <LandingHead title={job.line.word} head={landingHead(job.line)} running={job.line.running}
        timedOut={job.line.timedOut} />
      {job.line.what ? <div className="landing-jobs-what">{job.line.what}</div> : null}
      {job.detail ? <div className="landing-jobs-detail">{job.detail}</div> : null}
    </div>
  );
  return (
    <li className="landing-jobs-row" data-job={job.jobId}>
      {job.taskId ? (
        <ProjectTaskLink projectId={projectId} taskId={job.taskId} className="landing-jobs-open"
          onClick={onOpenTask}>
          {body}
          <RightOutlined className="landing-jobs-chev" aria-hidden />
        </ProjectTaskLink>
      ) : (
        <div className="landing-jobs-open">{body}</div>
      )}
      {job.retryable ? (
        <Button variant="primary" className="landing-jobs-retry" loading={retry.isPending}
          onClick={() => retry.mutate()}>
          {LANDING_WORDS.RETRY}
        </Button>
      ) : null}
      {/* The row's own way into the landing this job belongs to (owner 2026-10-19): a sibling of
          Retry and of the row's task link, never inside either. A merge into main lands no task and
          its row is no press, so this is that row's only way in — and a server that names no
          landing session gets the sentence instead of a link. */}
      <div className="landing-jobs-slot">
        {job.landingSessionId ? (
          <LandingLink className="landing-jobs-landing" sessionId={job.landingSessionId} />
        ) : (
          <LandingNoPage className="landing-jobs-landing is-none" />
        )}
      </div>
      {retry.isError ? (
        <div className="landing-jobs-error" role="alert">
          {/* The server's sentence ends with its own full stop; this line supplies one. */}
          {`${LANDING_WORDS.RETRY_FAILED} — ${retry.error.message.replace(/[.\s]+$/, '')}.`}
        </div>
      ) : null}
    </li>
  );
}
