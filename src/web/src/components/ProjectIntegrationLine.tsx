import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Radio, Select } from 'antd';
import type { ProjectIntegrationView } from '@orbit/shared';
import { api } from '../api';
import { projectIntegrationQuery } from '../lib/queries';
import { ago } from '../lib/watches';

/**
 * Where this project's finished work goes, in one line under its title — and, behind that line, the
 * three settings that decide it (`docs/project-integration-line-contract.md` §7.2 V3 / V4, mocks 2
 * and 6 ③).
 *
 * The row exists because "DONE" stopped being the end of a task's story. A task is done, then the
 * platform rebases it onto the line, runs the merge check on the combined tree, and lands it; main
 * is absorbed in the other direction; and none of that was visible anywhere, so a reader watching a
 * green project had no way to tell work that had shipped from work sitting on a branch. Five facts
 * answer it: which branch, how far ahead of main, when main last came in, what is in flight, and
 * whether the tip is green.
 *
 * The settings sit behind a NATIVE disclosure rather than a route or a modal. Two reasons, and the
 * first is the one that matters: `<details>` needs no state, so the card is in the document whether
 * or not it is open — a reader who cannot use a pointer reaches it, and so does a test rendering
 * this page to static markup. The second is that it belongs beside the line it describes: an
 * "Integration settings" link that navigated away would make the reader hold the row in their head.
 */

/** Seconds, as the escalation window is offered. The column's CHECK bounds it 300 to a week (§4.1);
 *  these are the points on that range worth a click, and a value outside them is shown as itself
 *  rather than snapped to the nearest one. */
const ESCALATION_CHOICES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 1800, label: '30 minutes' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 7200, label: '2 hours' },
  { seconds: 14400, label: '4 hours' },
  { seconds: 28800, label: '8 hours' },
  { seconds: 86400, label: '24 hours' },
];

/** The window in words, including a window nobody offered. */
function escalationLabel(seconds: number): string {
  const known = ESCALATION_CHOICES.find((choice) => choice.seconds === seconds);
  if (known) return known.label;
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** The merge check's verdict on the line's tip, as a word and a colour. UNKNOWN prints as itself:
 *  no finished job is a different thing from a job that failed, and the row must not round one to
 *  the other. */
const TIP_STATE: Record<ProjectIntegrationView['mergeCheckOnTip'], { text: string; color: string }> = {
  PASSING: { text: '✓ passing', color: 'var(--success)' },
  FAILING: { text: '✕ failing', color: 'var(--error)' },
  UNKNOWN: { text: 'not run yet', color: 'var(--text-3)' },
};

/** The branch mark from the mock, drawn rather than typed: `⎇` renders as a box in several of the
 *  fonts this app falls back to, and a box in front of a branch name reads as a broken glyph. */
function BranchMark() {
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
 * What `PATCH /projects/:id/integration` accepts (§1.2 L5). Sent as one object so the server
 * validates the whole choice at once — a branch name without the line it belongs to is not a
 * request anybody meant to make.
 */
interface IntegrationSettingsBody {
  line?: 'MAIN' | 'PROJECT_BRANCH';
  projectBranchName?: string;
  mergeCheckCommand?: string | null;
  mergeCheckTimeoutSeconds?: number | null;
  exceptionEscalationSeconds?: number;
}

function updateProjectIntegration(
  projectId: string,
  settings: IntegrationSettingsBody,
): Promise<ProjectIntegrationView> {
  return api<ProjectIntegrationView>(
    `/projects/${encodeURIComponent(projectId)}/integration`,
    { method: 'PATCH', body: settings },
  );
}

/** The default branch a project that has not chosen one would get (§1.2 L3), shown so the locked
 *  option still names something rather than trailing off. */
function proposedBranch(view: ProjectIntegrationView, projectId: string): string {
  return view.line === 'PROJECT_BRANCH' && view.ref ? view.ref : `project/${projectId}`;
}

/**
 * The three settings of mock 6 ③: where tasks land, what is run on the combined tree before they
 * do, and how long an exception may sit with the coordinator before it becomes the owner's.
 *
 * Only the first is ever locked. Once anything has integrated, moving the line would orphan
 * whatever is already on it — the server refuses it 409 `INTEGRATION_LINE_LOCKED` and so does a
 * database trigger (L4) — so the control is disabled and the reason is written out. The other two
 * stay editable for the life of the project, which is the whole difference between a decision and
 * a setting.
 */
function ProjectIntegrationSettingsCard({
  projectId,
  view,
}: {
  projectId: string;
  view: ProjectIntegrationView;
}) {
  const qc = useQueryClient();
  const [line, setLine] = useState<'MAIN' | 'PROJECT_BRANCH'>(view.line ?? 'PROJECT_BRANCH');
  const [check, setCheck] = useState(view.mergeCheckCommand ?? '');
  const [escalation, setEscalation] = useState(view.escalationSeconds);
  // A background refetch that lands while this is open must not fight the reader's typing, but it
  // must not leave them editing a project's settings from before somebody else changed them
  // either. Re-seeding on the identity of what came back is the middle: an unchanged payload
  // re-renders without touching the fields.
  useEffect(() => {
    setLine(view.line ?? 'PROJECT_BRANCH');
    setCheck(view.mergeCheckCommand ?? '');
    setEscalation(view.escalationSeconds);
  }, [view.line, view.mergeCheckCommand, view.escalationSeconds]);

  const save = useMutation({
    mutationFn: () =>
      updateProjectIntegration(projectId, {
        // The line is sent only while it can still be chosen: sending the value it already holds
        // would be refused 409 by the trigger, which is a confusing thing to do to a Save press.
        ...(view.locked ? {} : { line }),
        mergeCheckCommand: check.trim() === '' ? null : check,
        exceptionEscalationSeconds: escalation,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const branch = proposedBranch(view, projectId);
  const dirty =
    (!view.locked && line !== (view.line ?? 'PROJECT_BRANCH'))
    || check !== (view.mergeCheckCommand ?? '')
    || escalation !== view.escalationSeconds;

  return (
    <div className="project-integration-settings-card">
      <div className="project-integration-setting">
        <div className="project-integration-setting-label">Tasks land on</div>
        <Radio.Group
          value={line}
          disabled={view.locked}
          onChange={(event) => setLine(event.target.value)}
        >
          <Radio value="PROJECT_BRANCH" style={{ display: 'block', marginBottom: 8 }}>
            <b>A project branch</b> · <code>{branch}</code>
            <div className="project-integration-setting-hint">
              Recommended when tasks depend on each other. Tasks land here by themselves; merging
              into main asks you every time.
            </div>
          </Radio>
          <Radio value="MAIN" style={{ display: 'block' }}>
            <b>Directly into main</b>
            <div className="project-integration-setting-hint">
              For a single task or an urgent fix. Each task still lands only after the merge check
              passes.
            </div>
          </Radio>
        </Radio.Group>
      </div>

      {view.locked ? (
        <div className="project-integration-setting-hint" style={{ marginBottom: 12 }}>
          This project started integrating
          {view.startedAt ? ` ${ago(view.startedAt, Date.now())}` : ''}, so the line it lands on can
          no longer change. Merge it into main, or give up the branch, to start another.
        </div>
      ) : null}

      <div className="project-integration-setting">
        <div className="project-integration-setting-label">Merge check</div>
        <div>
          <Input
            value={check}
            placeholder="No check — work lands once it rebases cleanly"
            aria-label="Merge check command"
            onChange={(event) => setCheck(event.target.value)}
          />
          <div className="project-integration-setting-hint">
            Runs on the combined tree before anything lands — on the project branch and again
            before main.
          </div>
        </div>
      </div>

      <div className="project-integration-setting">
        <div className="project-integration-setting-label">Escalate after</div>
        <div>
          <Select
            value={escalation}
            style={{ width: 140 }}
            aria-label="Escalate after"
            onChange={setEscalation}
            options={(ESCALATION_CHOICES.some((choice) => choice.seconds === escalation)
              ? ESCALATION_CHOICES
              : [...ESCALATION_CHOICES, { seconds: escalation, label: escalationLabel(escalation) }]
            ).map((choice) => ({ value: choice.seconds, label: choice.label }))}
          />
          <div className="project-integration-setting-hint">
            Items the coordinator hasn’t handled by then come to you.
          </div>
        </div>
      </div>

      <div className="project-integration-setting-actions">
        <Button
          type="primary"
          size="small"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
        {save.error ? (
          <span style={{ color: 'var(--error)', fontSize: 12.5 }}>{save.error.message}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The line itself, under the project's title.
 *
 * Fetches its own read for the same reason the panorama header does: it is one of several cards on
 * this page that each read a different endpoint, and a row taking its numbers as props would make
 * the page decide when to poll for something it otherwise knows nothing about.
 *
 * Draws nothing at all while the answer has not arrived, and nothing when nobody has chosen a line
 * and nothing has integrated: a project with no line has no row to show, and a placeholder saying
 * so would put a sentence about machinery above the title of every project that does not use it.
 */
export function ProjectIntegrationLine({ projectId }: { projectId: string }) {
  const integration = useQuery({
    ...projectIntegrationQuery(projectId),
    enabled: Boolean(projectId),
  });

  if (integration.isPending) return null;
  if (integration.isError || !integration.data) return null;
  const view = integration.data;
  if (!view.line) return null;

  const branchLine = view.line === 'PROJECT_BRANCH';
  const tip = TIP_STATE[view.mergeCheckOnTip] ?? TIP_STATE.UNKNOWN;
  const ahead = view.commitsAheadOfUpstream;

  return (
    <details className="project-integration">
      <summary className="project-integration-row">
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
                <b>{ahead}</b> commit{ahead === 1 ? '' : 's'} ahead of main
              </span>
            </>
          ) : null}
          {branchLine && view.lastUpstreamSyncAt ? (
            <>
              <Separator />
              <span>synced with main {ago(view.lastUpstreamSyncAt, Date.now())}</span>
            </>
          ) : null}

          <Separator />
          <span>
            <b>Integrating</b> {view.integratingCount} <Separator /> <b>Queued</b>{' '}
            {view.queuedCount}
          </span>
          <Separator />
          <span>
            Merge check <span style={{ color: tip.color }}>{tip.text}</span>
            {branchLine ? ' on the branch tip' : ''}
          </span>
        </span>
        <span className="project-integration-settings-entry">Integration settings</span>
      </summary>
      <ProjectIntegrationSettingsCard projectId={projectId} view={view} />
    </details>
  );
}
