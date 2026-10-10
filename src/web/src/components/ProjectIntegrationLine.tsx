import { useQuery } from '@tanstack/react-query';
import type { ProjectIntegrationView } from '@orbit/shared';
import { Link } from 'react-router-dom';
import { LandTaskStatus } from './LandTaskStatus';
import { projectTaskPath } from '../lib/projectTaskRoute';
import {
  RUN_LINE_DECIDED_AT_START,
  RUN_LINE_SUGGESTED,
  RUN_TASKS_LAND_ON,
  mainBranchName,
  runLineInSentence,
  startMainBranch,
} from '../lib/projectStart';
import { projectIntegrationQuery, projectOpenItemsQuery } from '../lib/queries';
import { ago } from '../lib/watches';

/**
 * Where this project's finished work goes, in one line under its title
 * (`docs/project-integration-line-contract.md` §7.2 V3, mock 2).
 *
 * The row exists because "DONE" stopped being the end of a task's story. A task is done, then the
 * platform rebases it onto the line, runs the merge check on the combined tree, and lands it; main
 * is absorbed in the other direction; and none of that was visible anywhere, so a reader watching a
 * green project had no way to tell work that had shipped from work sitting on a branch. Five facts
 * answer it: which branch, how far ahead of main, when main last came in, what is in flight, and
 * what the last landing attempt's checks reported. Under them, each current landing (§2.7a).
 *
 * The settings that decide the line are no longer behind this row: they are the project's "How it
 * runs" block (`ProjectRunSettings`), with Automatic and the rest of what the start card set, so a
 * question the start card answered is changed in one place afterwards.
 */

/** The last landing attempt's checks, not a claim about the current branch tip. */
const TIP_STATE: Record<ProjectIntegrationView['mergeCheckOnTip'], { text: string; color: string }> = {
  PASSING: { text: '✓ passing', color: 'var(--success)' },
  FAILING: { text: '✕ failing', color: 'var(--error)' },
  UNKNOWN: { text: 'not checked', color: 'var(--text-3)' },
};

/** The branch mark from the mock, drawn rather than typed: `⎇` renders as a box in several of the
 *  fonts this app falls back to, and a box in front of a branch name reads as a broken glyph.
 *
 *  Exported because the projects index draws the same mark on a list row (§7.1 V1) — one glyph
 *  that means "branch" in both places, rather than two drawings that agree until one is nudged. */
export function BranchMark() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none' }}
    >
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="5.5" r="1.6" />
      <path d="M4 5.1v5.8M12 7.1c0 3-3 3.2-6.4 4.6" />
    </svg>
  );
}

const Separator = () => (
  <span aria-hidden="true" style={{ color: 'var(--text-4)' }}>
    ·
  </span>
);

/**
 * The line itself, under the project's title.
 *
 * Fetches its own read for the same reason the panorama header does: it is one of several cards on
 * this page that each read a different endpoint, and a row taking its numbers as props would make
 * the page decide when to poll for something it otherwise knows nothing about.
 *
 * Draws nothing while the answer has not arrived. A project nobody has started and nobody has
 * chosen a line for says that the start decides it — and, once its coordinator has asked to start,
 * which line the coordinator suggests (the same open items read the page's Open items card makes).
 * A started project with no line and nothing integrated has no row to show: its line is chosen
 * under How it runs.
 */
export function ProjectIntegrationLine({
  projectId,
  started,
}: {
  projectId: string;
  /** Whether the project has been started (`startedAt`), from the document the page holds; null
   *  when that read does not say. */
  started?: boolean | null;
}) {
  const integration = useQuery({
    ...projectIntegrationQuery(projectId),
    enabled: Boolean(projectId),
  });
  const items = useQuery({
    ...projectOpenItemsQuery(projectId),
    enabled: Boolean(projectId) && started === false,
  });

  if (integration.isPending) return null;
  if (integration.isError || !integration.data) return null;
  const view = integration.data;
  if (!view.line) {
    if (started !== false) return null;
    const suggestion = items.data?.startRequest?.startRequest?.settings ?? null;
    const suggested = suggestion?.line ?? null;
    return (
      <div className="project-integration">
        <div className="project-integration-row">
          <span className="project-integration-undecided">
            <BranchMark />
            <span>
              {`${RUN_TASKS_LAND_ON}: `}
              <b>{RUN_LINE_DECIDED_AT_START}</b>
              {suggested ? (
                <>
                  {` — ${RUN_LINE_SUGGESTED} `}
                  {/* Directly into the main branch the start card opens with. */}
                  <b>{runLineInSentence(suggested, startMainBranch(suggestion?.upstreamRef, view))}</b>
                </>
              ) : null}
            </span>
          </span>
        </div>
      </div>
    );
  }

  const branchLine = view.line === 'PROJECT_BRANCH';
  const tip = TIP_STATE[view.mergeCheckOnTip] ?? TIP_STATE.UNKNOWN;
  const ahead = view.commitsAheadOfUpstream;
  const main = mainBranchName(view.upstreamRef);

  return (
    <div className="project-integration">
      <div className="project-integration-row">
        <span className="project-integration-facts">
          {branchLine ? (
            <span className="project-integration-branch">
              <BranchMark />
              {view.ref}
            </span>
          ) : (
            <span className="project-integration-branch">{view.upstreamRef ?? 'main'}</span>
          )}

          {/* Two facts that only mean something on a branch: a project landing straight into main
              is never ahead of it, and never syncs from it. Printed as zeroes they would read as
              "nothing has happened", which is a different claim. */}
          {branchLine && ahead !== null ? (
            <>
              <Separator />
              <span>
                <b>{ahead}</b> commit{ahead === 1 ? '' : 's'} ahead of {main} at last measurement
              </span>
            </>
          ) : null}
          {branchLine && view.lastUpstreamSyncAt ? (
            <>
              <Separator />
              <span>synced with {main} {ago(view.lastUpstreamSyncAt, Date.now())}</span>
            </>
          ) : null}

          <Separator />
          <span>
            <b>Running jobs</b> {view.integratingCount} <Separator /> <b>Queued</b>{' '}
            {view.queuedCount}
          </span>
          <Separator />
          <span>
            Last landing check <span style={{ color: tip.color }}>{tip.text}</span>
          </span>
        </span>
      </div>
      {/* The current landings (§2.7a): what the queue is doing, what stopped, what landed last —
          each in the task page's own words, so a DONE task's landing is visible before anything
          fails. Read-only; the doors that act on a stop are its exception card's. */}
      {view.landTasks && view.landTasks.length > 0 ? (
        <div className="project-land-tasks" aria-label="Current landings">
          {view.landTasks.map((task) => (
            <div className="project-land-task" key={task.taskId}>
              <Link className="project-land-task-title" to={projectTaskPath(projectId, task.taskId)}>
                {task.taskTitle}
              </Link>
              <LandTaskStatus integration={task.integration} main={main} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
