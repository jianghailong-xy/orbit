import { CheckOutlined, FileOutlined } from '@ant-design/icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchSharedAttachmentObjectUrl,
  type ShareInclude,
  type SharedTask,
  type SharedTaskEdge,
  type SharedTaskRun,
} from '../api';
import { AppLink } from '../components/AppLink';
import { PublicShell } from '../components/PublicShell';
import { COMPLETION_CRITERION_CHIP, SESSION_STATE_META } from '../components/TaskDetailPanel';
import { TaskStatusPill } from '../components/TaskStatusPill';
import { AttachmentResolverContext, MD, PublicLinkResolverCtx } from '../components/Transcript';
import { checkDuration } from '../lib/checkDuration';
import { encodeId } from '../lib/idCodec';
import { taskLinkResolver } from '../lib/publicLinks';
import { countOf, shortDate } from '../lib/shareLinks';
import { taskOutcomeChip } from '../lib/taskOutcome';
import { titleFirstLine } from '../lib/title';
import { ACCEPTANCE_EMPTY } from './TaskDetailPage';

/** What the declared judgment means, said to somebody who does not own the task. */
const JUDGED_HOW: Record<string, (task: SharedTask) => string> = {
  EXECUTABLE: (task) =>
    `Judged by its acceptance command — it is done when the command exits ${task.acceptanceExpectedExitCode ?? 0}.`,
  VERIFICATION: () => 'Judged by an independent check — a separate verification task decides.',
  EVIDENCE_JUDGMENT: () => 'Judged by submitted evidence — an independent session confirms it.',
  OWNER_CONFIRMED: () => 'Judged by the account owner, who confirms it in Orbit.',
};

const when = (iso: string): string =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

function Card({ block, title, hint, children }: { block: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="share-card" data-block={block}>
      <div className="share-card-head">
        <h2 className="share-card-title">{title}</h2>
        {hint != null && <span className="share-card-hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** A task this one is connected to. Its title is a link only where the link shares that task. */
function EdgeRow({ relation, edge }: { relation: string; edge: SharedTaskEdge }) {
  return (
    <div className="share-dep">
      <span className="share-dep-relation">{relation}</span>
      <span className="share-dep-title" title={edge.title}>
        <AppLink to={`/tasks/${encodeId(edge.id)}`}>{edge.title}</AppLink>
      </span>
      <TaskStatusPill status={edge.status} />
    </div>
  );
}

function Dependencies({ dependencies }: { dependencies: SharedTask['dependencies'] }) {
  const upstream = dependencies.prerequisites.length + dependencies.prerequisitesInOtherProjects;
  const downstream = dependencies.dependents.length + dependencies.dependentsInOtherProjects;
  const connected = upstream + downstream;
  return (
    <Card
      block="dependencies"
      title="Dependencies"
      hint={connected > 0 ? `${connected} connected · ${upstream} upstream · ${downstream} downstream` : undefined}
    >
      {connected === 0 ? (
        <div className="share-muted">No dependencies</div>
      ) : (
        <div className="share-deps">
          {dependencies.prerequisites.map((edge) => (
            <EdgeRow key={`needs-${edge.id}`} relation="Needs" edge={edge} />
          ))}
          {dependencies.prerequisitesInOtherProjects > 0 && (
            <div className="share-dep is-elsewhere">
              <span className="share-dep-relation">Needs</span>
              <span className="share-dep-title">
                {countOf(dependencies.prerequisitesInOtherProjects, 'prerequisite')} in another project
              </span>
            </div>
          )}
          {dependencies.dependents.map((edge) => (
            <EdgeRow key={`unblocks-${edge.id}`} relation="Unblocks" edge={edge} />
          ))}
          {dependencies.dependentsInOtherProjects > 0 && (
            <div className="share-dep is-elsewhere">
              <span className="share-dep-relation">Unblocks</span>
              <span className="share-dep-title">
                {countOf(dependencies.dependentsInOtherProjects, 'task')} in another project
              </span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * The description, folded to its first lines when it runs past them. Measured rather than counted:
 * how much fits depends on the script and the width, not on how many characters there are.
 */
function Description({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text]);
  return (
    <Card block="description" title="Description">
      <div ref={body} className={`share-prose${open ? '' : ' is-folded'}${long && !open ? ' is-fading' : ''}`}>
        <MD breaks>{text}</MD>
      </div>
      {long && (
        <button type="button" className="share-more" onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </Card>
  );
}

function Acceptance({ task }: { task: SharedTask }) {
  const judged = JUDGED_HOW[task.completionCriterion]?.(task);
  return (
    <Card block="acceptance" title="Acceptance">
      {task.acceptanceCriteria ? (
        <div className="share-prose">
          <MD breaks>{task.acceptanceCriteria}</MD>
        </div>
      ) : (
        <div className="share-muted">{ACCEPTANCE_EMPTY}</div>
      )}
      {task.acceptanceCommand && task.acceptanceExpectedExitCode != null && (
        <div className="share-acceptance-pair">
          <code className="share-acceptance-command">{task.acceptanceCommand}</code>
          <span className="share-muted">
            done when it exits <code>{task.acceptanceExpectedExitCode}</code>
          </span>
        </div>
      )}
      {judged && <div className="share-card-note">{judged}</div>}
    </Card>
  );
}

/** One input file: opened through the link's own attachment route, never the owner's. */
function InputFile({ token, input }: { token: string; input: NonNullable<SharedTask['inputs']>[number] }) {
  const open = () => {
    void fetchSharedAttachmentObjectUrl(token, input.id)
      .then((url) => window.open(url, '_blank', 'noopener'))
      .catch(() => undefined);
  };
  return (
    <button type="button" className="share-input" onClick={open} title="Open this file">
      <FileOutlined />
      <span className="share-input-name">{input.fileName ?? 'attachment'}</span>
      <span className="share-muted">{humanSize(input.sizeBytes)}</span>
    </button>
  );
}

function RunRow({ token, run }: { token: string; run: SharedTaskRun }) {
  const meta = SESSION_STATE_META[run.state as keyof typeof SESSION_STATE_META] ?? { label: run.state, tone: 'muted' };
  const duration = run.durationMs != null ? ` · ${checkDuration(run.durationMs)}` : '';
  return (
    <div className="share-run">
      <span className={`tdp-badge tone-${meta.tone}`}>{meta.label}</span>
      <span className="share-run-when">
        {when(run.startedAt)}
        {duration}
      </span>
      {run.sessionId ? (
        <Link className="share-run-open" to={`/s/${encodeURIComponent(token)}/c/${encodeId(run.sessionId)}`}>
          View conversation ›
        </Link>
      ) : (
        <span className="share-run-open share-muted">Conversation not shared</span>
      )}
    </div>
  );
}

function Comments({ comments }: { comments: NonNullable<SharedTask['comments']> }) {
  const [all, setAll] = useState(false);
  const earlier = comments.length - 1;
  const shown = all || earlier <= 0 ? comments : comments.slice(-1);
  return (
    <Card block="comments" title="Comments" hint={comments.length}>
      {comments.length === 0 ? (
        <div className="share-muted">No comments yet</div>
      ) : (
        <>
          {shown.map((comment, i) => (
            <div key={`${comment.createdAt}-${i}`} className="share-comment">
              <div className="share-comment-head">
                <span className="share-comment-avatar" aria-hidden>
                  {comment.author.trim().charAt(0).toLowerCase()}
                </span>
                <span className="share-comment-author">{comment.author}</span>
                <span className="share-muted">{when(comment.createdAt)}</span>
              </div>
              <div className="share-prose">
                <MD breaks>{comment.body}</MD>
              </div>
            </div>
          ))}
          {!all && earlier > 0 && (
            <button type="button" className="share-more" onClick={() => setAll(true)}>
              Show {countOf(earlier, 'earlier comment')}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * The public page of a task link (`/s/<token>`, kind TASK): the task as its layers show it, inside
 * the frame every public page shares, in the order the app's task panel draws the same blocks
 * (docs/share-links-design.md §7) — the header (how it ended, how that is judged, when), then
 * Dependencies, Description, Acceptance and Runs; the layers add theirs where the panel has them,
 * the input files under Acceptance and the comments last. Nothing on it links into the app: the
 * task's own name and its runs resolve to this link's pages, everything else is words
 * (lib/publicLinks taskLinkResolver). Images in its text come through the link's attachment route.
 */
export function SharedTaskPage({
  token,
  data,
}: {
  token: string;
  data: { include: ShareInclude; root: SharedTask };
}) {
  const task = data.root;
  const resolve = useMemo(
    () =>
      taskLinkResolver(token, {
        taskId: task.id,
        runSessionIds: task.runs.flatMap((run) => (run.sessionId ? [run.sessionId] : [])),
      }),
    [token, task],
  );
  const attachment = useMemo(() => (id: string) => fetchSharedAttachmentObjectUrl(token, id), [token]);

  useEffect(() => {
    const prev = document.title;
    document.title = `${titleFirstLine(task.title)} — Orbit`;
    return () => {
      document.title = prev;
    };
  }, [task.title]);

  const outcome = taskOutcomeChip({ status: task.status, terminalReason: outcomeReason(task.outcome) });
  const judged = COMPLETION_CRITERION_CHIP[task.completionCriterion];
  return (
    <PublicShell
      crumbs={[
        // The project it is filed under, by name: a task link does not share it, so it is words.
        ...(task.project ? [{ label: task.project.title }] : []),
        { label: titleFirstLine(task.title) },
      ]}
    >
      <PublicLinkResolverCtx.Provider value={resolve}>
        <AttachmentResolverContext.Provider value={attachment}>
          <article className="share-task">
            <header className="share-task-head" data-block="header">
              <h1 className="share-task-title">{task.title}</h1>
              <div className="share-task-meta">
                <span className={`tdp-badge tone-${outcome.tone}`}>{outcome.label}</span>
                {judged && (
                  <span className="share-task-judged">
                    <CheckOutlined />
                    {judged}
                  </span>
                )}
                <span className="share-muted">Created {shortDate(task.createdAt)}</span>
              </div>
              {task.supersededBy && (
                <div className="share-task-superseded">
                  Superseded by{' '}
                  {task.supersededBy.id ? (
                    <AppLink to={`/tasks/${encodeId(task.supersededBy.id)}`}>{task.supersededBy.title}</AppLink>
                  ) : (
                    task.supersededBy.title
                  )}
                </div>
              )}
            </header>
            <Dependencies dependencies={task.dependencies} />
            {task.description && <Description text={task.description} />}
            <Acceptance task={task} />
            {task.inputs && task.inputs.length > 0 && (
              <Card block="inputs" title="Inputs" hint={task.inputs.length}>
                <div className="share-inputs">
                  {task.inputs.map((input) => (
                    <InputFile key={input.id} token={token} input={input} />
                  ))}
                </div>
              </Card>
            )}
            <Card block="runs" title="Runs" hint={task.runs.length}>
              {task.runs.length === 0 ? (
                <div className="share-muted">No runs yet</div>
              ) : (
                <div className="share-runs">
                  {task.runs.map((run, i) => (
                    <RunRow key={run.sessionId ?? `${run.startedAt}-${i}`} token={token} run={run} />
                  ))}
                </div>
              )}
            </Card>
            {task.comments && <Comments comments={task.comments} />}
          </article>
        </AttachmentResolverContext.Provider>
      </PublicLinkResolverCtx.Provider>
    </PublicShell>
  );
}

/** The terminal reason an outcome word stands for, so the app's own chip draws it. */
function outcomeReason(outcome: string): string | null {
  return outcome === 'SUPERSEDED' || outcome === 'ABANDONED' ? outcome : null;
}
