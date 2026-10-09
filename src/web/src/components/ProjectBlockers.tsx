import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Tag, Typography } from 'antd';
import { api } from '../api';
import { routeId } from '../lib/idCodec';
import { sourceRefusalWhy } from '../lib/sourceRefusal';

/**
 * The Blockers card on the project page (mock 6, docs/mocks/project-progress/): every open
 * `project_blocker` with its kind, the work it is about, what it asks for and the files it names,
 * and the one press that ends it — with a reason, which the server records beside who gave it.
 *
 * Drawn from the project document (`GET /projects/:id` serves `blockers`), so it adds no read of
 * its own. It draws nothing while nothing is open.
 */

/** One blocker as the project read serves it. `detail` is display only, exactly as on the server. */
export interface ProjectBlocker {
  id: string;
  kind: string;
  owner: 'USER' | 'COORDINATOR' | 'SYSTEM';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  requiredAction: string;
  subjectType: string;
  subjectId: string;
  /** The task's title when the blocker is about a task. */
  subjectTitle: string | null;
  /** The task's own explanation, when it argued that a criterion did not apply. */
  agentArgument?: string | null;
  /** The criterion that task is filed against, as it stands today. */
  criterionOrdinal: number | null;
  criterionRevision: number | null;
  /** The current wording of the criterion, when the task still points at one. */
  criterionText?: string | null;
  /** The SOURCE_UNRESOLVED fields, written by the door that freezes a refused start: the §10.1
   *  code, its pairing, the ref that could not be resolved, and the tasks whose starts it refused. */
  detail: {
    reason?: string;
    paths?: string[];
    code?: string;
    fixAction?: string;
    ref?: string;
    taskIds?: string[];
  } & Record<string, unknown>;
  firstSeenAt: string;
  resolvedAt: string | null;
  resolvedBy: 'AUTO' | 'USER' | 'COORDINATOR' | null;
  resolutionNote: string | null;
}

export interface ProjectBlockers {
  open: ProjectBlocker[];
  /** The most recently resolved, newest first — not all of them; `resolvedCount` is the total. */
  resolved: ProjectBlocker[];
  resolvedCount: number;
}

interface Headline {
  tag: string;
  color: string;
  title: string;
}

/** The deliveries a machine may not settle (`blocker-disposition.ts`), in the words of mock 6. */
const REASON_HEADLINE: Readonly<Record<string, Headline>> = {
  OUTSIDE_DECLARED_SCOPE: {
    tag: 'Needs your approval',
    color: 'gold',
    title: 'Changed files it didn’t declare',
  },
  ACCEPTANCE_STANDARD_MOVED: {
    tag: 'Standard moved',
    color: 'gold',
    title: 'Its acceptance criterion changed after it started',
  },
  CRITERION_EXEMPTION_ARGUED: {
    tag: 'Needs your decision',
    color: 'gold',
    title: 'Agent says this criterion doesn’t apply',
  },
  MERGE_REFUSED_BY_GIT: { tag: 'Merge conflict', color: 'red', title: 'Git refused to merge it' },
};

/** Every other kind is named by its code, beside who has to act on it. */
const OWNER_TAG: Readonly<Record<ProjectBlocker['owner'], Omit<Headline, 'title'>>> = {
  USER: { tag: 'Needs you', color: 'gold' },
  COORDINATOR: { tag: 'Coordinator', color: 'blue' },
  SYSTEM: { tag: 'System', color: 'default' },
};

export function blockerHeadline(blocker: ProjectBlocker): Headline {
  const reason = blocker.detail?.reason;
  const known = typeof reason === 'string' ? REASON_HEADLINE[reason] : undefined;
  if (known) return known;
  // A refused start (§10.3 / SR50) is named by what it costs the reader — a project whose runs
  // cannot start — rather than by its kind's words, and by the line itself when that is what is
  // missing. The kind stays spelled out underneath (`blockerSourceRefusalLine`), because it is the
  // word the server, the contract and a task comment all use for this.
  if (blocker.kind === 'SOURCE_UNRESOLVED') {
    return {
      ...(OWNER_TAG[blocker.owner] ?? OWNER_TAG.SYSTEM),
      title:
        blocker.detail?.fixAction === 'FIX_REF'
          ? 'Integration line not created'
          : 'Runs can’t start from this project’s line',
    };
  }
  const words = blocker.kind.toLowerCase().split('_').filter(Boolean).join(' ');
  return {
    ...(OWNER_TAG[blocker.owner] ?? OWNER_TAG.SYSTEM),
    title: words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : blocker.kind,
  };
}

/**
 * The subject line of a refused-start blocker: the kind, and the ref that could not be resolved.
 *
 * The two together on purpose. The kind is what a coordinator's report and the task's own timeline
 * call this (`SOURCE_UNRESOLVED`), so a reader arriving from either can match what they read there
 * to what they see here; the ref is the address that is missing, which is the whole of the fix.
 */
export function blockerSourceRefusalLine(blocker: ProjectBlocker): string | null {
  if (blocker.kind !== 'SOURCE_UNRESOLVED') return null;
  const ref = typeof blocker.detail?.ref === 'string' ? blocker.detail.ref : null;
  return ref ? `${blocker.kind} · ${ref}` : blocker.kind;
}

/** The tasks a refused start names: the runs this line refused, newest first as the door wrote them. */
export function blockerRefusedTaskIds(blocker: ProjectBlocker): string[] {
  const ids = blocker.kind === 'SOURCE_UNRESOLVED' ? blocker.detail?.taskIds : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '') : [];
}

/** The work a blocker is about, and for a moved standard, where that standard stands now. */
export function blockerSubjectLine(blocker: ProjectBlocker): string | null {
  const parts: string[] = [];
  if (blocker.subjectTitle) parts.push(blocker.subjectTitle);
  if (
    blocker.detail?.reason === 'ACCEPTANCE_STANDARD_MOVED'
    && blocker.criterionOrdinal != null
    && blocker.criterionRevision != null
  ) {
    parts.push(`criterion ${blocker.criterionOrdinal} is now revision ${blocker.criterionRevision}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface DecisionPrompt {
  question: string;
  acceptLabel: string;
  keepLabel: string;
}

/** The question the card should make legible before a person writes a resolution note. */
const DECISION_PROMPTS: Readonly<Record<string, DecisionPrompt>> = {
  CRITERION_EXEMPTION_ARGUED: {
    question: 'Does the agent’s explanation make this criterion inapplicable to this work?',
    acceptLabel: 'Accept the explanation',
    keepLabel: 'Leave it open',
  },
  OUTSIDE_DECLARED_SCOPE: {
    question: 'Are these extra files part of the delivery you want to accept?',
    acceptLabel: 'Accept these files',
    keepLabel: 'Leave it open',
  },
  ACCEPTANCE_STANDARD_MOVED: {
    question: 'Does this delivery satisfy the criterion as it reads today?',
    acceptLabel: 'Confirm it meets the criterion',
    keepLabel: 'Leave it open',
  },
  MERGE_REFUSED_BY_GIT: {
    question: 'Has the merge conflict been resolved and checked?',
    acceptLabel: 'Mark the conflict resolved',
    keepLabel: 'Leave it open',
  },
};

export function blockerDecisionPrompt(blocker: ProjectBlocker): DecisionPrompt | null {
  const reason = blocker.detail?.reason;
  return typeof reason === 'string' ? DECISION_PROMPTS[reason] ?? null : null;
}

function pathsOf(blocker: ProjectBlocker): string[] {
  const paths = blocker.detail?.paths;
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
}

function showsCriterion(blocker: ProjectBlocker): boolean {
  const reason = blocker.detail?.reason;
  return reason === 'CRITERION_EXEMPTION_ARGUED' || reason === 'ACCEPTANCE_STANDARD_MOVED';
}

const PATHS_SHOWN = 2;

/**
 * The files, short enough for one line: the first whole, the next by name when it sits in the same
 * directory, and the rest counted. Every path is still in the element's title.
 */
export function blockerPathsLine(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0]!;
  const folder = first.slice(0, first.lastIndexOf('/') + 1);
  const shown = paths.slice(0, PATHS_SHOWN).map((path, index) => {
    const rest = path.slice(folder.length);
    return index > 0 && folder && path.startsWith(folder) && !rest.includes('/') ? rest : path;
  });
  const hidden = paths.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`+${hidden}`] : [])].join(' · ');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function sinceLabel(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return 'since just now';
  if (elapsed < HOUR) return `since ${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `since ${Math.floor(elapsed / HOUR)}h`;
  return `since ${Math.floor(elapsed / DAY)}d`;
}

function shortTime(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** How one blocker ended, and when: "Auto-resolved — the work landed on main (09-07 11:46)". */
export function resolutionLine(blocker: ProjectBlocker): string {
  const when = blocker.resolvedAt ? ` (${shortTime(blocker.resolvedAt)})` : '';
  const note = blocker.resolutionNote?.trim();
  switch (blocker.resolvedBy) {
    case 'AUTO':
      return `Auto-resolved — ${note || 'its condition no longer holds'}${when}`;
    case 'USER':
      return `Resolved by you — ${note || 'no reason was recorded'}${when}`;
    case 'COORDINATOR':
      return `Resolved by the coordinator${note ? ` — ${note}` : ''}${when}`;
    default:
      return `Resolved${when}`;
  }
}

/** The write: the reason travels in the body, and the server records who sent it. */
export function resolveProjectBlocker(
  projectId: string,
  blocker: Pick<ProjectBlocker, 'id'>,
  reason: string,
): Promise<ProjectBlocker> {
  return api<ProjectBlocker>(
    `/projects/${encodeURIComponent(projectId)}/blockers/${encodeURIComponent(blocker.id)}/resolve`,
    { method: 'POST', body: { reason } },
  );
}

/** One refused run's task, as the project's own task page names it. The id is the address; the
 *  title and status are what the page adds when it has resolved that far. */
interface RefusedTaskRow {
  id: string;
  title?: string;
  status?: string;
}

/**
 * The tasks a refused start names, read off the project's own task page.
 *
 * Deliberately the page's query key and URL, so the read this card makes is the read the task list
 * below already makes — one request, one cache entry, and the two cannot disagree about a row. The
 * read is only made when a blocker actually names tasks (most projects have none), and a row whose
 * task the page has not resolved still draws: the id is the address, and a card that hid it would
 * be hiding the one thing the reader can act on.
 */
function RefusedTaskList({ projectId, taskIds }: { projectId: string; taskIds: string[] }) {
  const tasks = useQuery({
    queryKey: ['project', projectId, 'tasks', 'root'],
    queryFn: () =>
      api<{ items: RefusedTaskRow[] }>(
        `/projects/${encodeURIComponent(projectId)}/tasks/page?limit=100`,
      ),
    enabled: taskIds.length > 0,
  });
  const byId = new Map((tasks.data?.items ?? []).map((task) => [task.id, task]));
  return (
    <ul className="project-blockers-tasks">
      {taskIds.map((id) => {
        const task = byId.get(id);
        return (
          <li key={id}>
            <span className="project-blockers-task-dot" aria-hidden="true" />
            <a className="project-blockers-task-title" href={`/tasks/${encodeURIComponent(id)}`}>
              {task?.title ?? id}
            </a>
            {/* What this blocker says about that row: its start is the one this line refused. Not
                the task's own status, which a refusal deliberately does not change. */}
            <span className="project-blockers-task-state" title={blockerTaskStateTitle}>
              Refused
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Why a row above reads "Refused" although the task's own status is untouched. */
const blockerTaskStateTitle =
  'This task’s start was refused before it ran; the task itself was not changed.';

function BlockerRow({
  blocker,
  projectId,
  now,
  onResolve,
}: {
  blocker: ProjectBlocker;
  projectId: string;
  now: number;
  onResolve: () => void;
}) {
  const headline = blockerHeadline(blocker);
  const subject = blockerSubjectLine(blocker);
  const paths = pathsOf(blocker);
  const pathsLine = blockerPathsLine(paths);
  const prompt = blockerDecisionPrompt(blocker);
  const criterionVisible = showsCriterion(blocker);
  const taskPublicId = blocker.subjectType === 'TASK' ? routeId(blocker.subjectId) : null;
  const sourceRefusal = blockerSourceRefusalLine(blocker);
  const refusedTaskIds = blockerRefusedTaskIds(blocker);
  return (
    <li className="project-blockers-row">
      <div className="project-blockers-main">
        <div className="project-blockers-headline">
          <Tag color={headline.color}>{headline.tag}</Tag>
          <span>{headline.title}</span>
        </div>
        {/* What the refusal was, in the sentence the session card over the refused conversation
            shows — one table (`lib/sourceRefusal`), so the two screens describe one refusal
            identically. The step below them is the server's own `requiredAction`. */}
        {sourceRefusal ? (
          <>
            <div className="project-blockers-why">{sourceRefusalWhy(blocker.detail?.fixAction)}</div>
            <div className="project-blockers-refusal">{sourceRefusal}</div>
          </>
        ) : null}
        {subject ? (
          <div className="project-blockers-subject">
            {taskPublicId ? (
              <a href={`/tasks/${encodeURIComponent(taskPublicId)}`}>{subject}</a>
            ) : subject}
          </div>
        ) : null}
        {prompt ? <div className="project-blockers-question">{prompt.question}</div> : null}
        {blocker.agentArgument?.trim() && blocker.detail?.reason === 'CRITERION_EXEMPTION_ARGUED' ? (
          <details className="project-blockers-evidence" open>
            <summary>Agent’s explanation</summary>
            <p>{blocker.agentArgument.trim()}</p>
          </details>
        ) : null}
        {criterionVisible && blocker.criterionText?.trim() ? (
          <details className="project-blockers-evidence" open>
            <summary>
              {blocker.criterionOrdinal != null
                ? `Current criterion ${blocker.criterionOrdinal}`
                : 'Current criterion'}
            </summary>
            <p>{blocker.criterionText.trim()}</p>
          </details>
        ) : null}
        <div className="project-blockers-next">
          <span>Next step</span>
          {blocker.requiredAction}
        </div>
        {/* Which runs this is about, so the reader can go and change their baseline rather than
            guess which tasks the line stopped. */}
        {refusedTaskIds.length > 0 ? (
          <RefusedTaskList projectId={projectId} taskIds={refusedTaskIds} />
        ) : null}
        {pathsLine ? (
          <details className="project-blockers-files">
            <summary className="project-blockers-paths">{pathsLine}</summary>
            <ul>
              {paths.map((path) => <li key={path}><code>{path}</code></li>)}
            </ul>
          </details>
        ) : null}
      </div>
      <div className="project-blockers-side">
        <time className="project-blockers-age" dateTime={blocker.firstSeenAt}>
          {sinceLabel(blocker.firstSeenAt, now)}
        </time>
        <Button size="small" type={prompt ? 'primary' : 'default'} onClick={onResolve}>
          {prompt ? 'Review…' : 'Resolve…'}
        </Button>
      </div>
    </li>
  );
}

function ResolveBlockerDialog({
  projectId,
  blocker,
  onClose,
}: {
  projectId: string;
  blocker: ProjectBlocker | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const fieldId = useId();
  const [reason, setReason] = useState('');
  const resolve = useMutation({
    mutationFn: (input: { blocker: ProjectBlocker; reason: string }) =>
      resolveProjectBlocker(projectId, input.blocker, input.reason),
    onSuccess: () => {
      setReason('');
      onClose();
    },
    // Refused or not, the project document is re-read: a blocker that was resolved elsewhere in
    // the meantime leaves the card, and its counts on the projects list move with it.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const cancel = () => {
    if (resolve.isPending) return;
    resolve.reset();
    setReason('');
    onClose();
  };
  const trimmed = reason.trim();
  const subject = blocker
    ? [blockerHeadline(blocker).title, blocker.subjectTitle].filter(Boolean).join(' · ')
    : '';
  const prompt = blocker ? blockerDecisionPrompt(blocker) : null;
  const paths = blocker ? pathsOf(blocker) : [];
  const criterionVisible = blocker ? showsCriterion(blocker) : false;

  return (
    <Modal
      open={blocker !== null}
      title={prompt ? 'Review this blocker' : 'Resolve this blocker'}
      closable={false}
      onCancel={cancel}
      footer={
        <div className="project-blockers-dialog-foot">
          <span className="project-blockers-dialog-note">Accepting records your name and note</span>
          <Button onClick={cancel} disabled={resolve.isPending}>
            {prompt?.keepLabel ?? 'Cancel'}
          </Button>
          <Button
            type="primary"
            disabled={trimmed === ''}
            loading={resolve.isPending}
            onClick={() => {
              if (blocker && trimmed !== '') resolve.mutate({ blocker, reason: trimmed });
            }}
          >
            {prompt?.acceptLabel ?? 'Resolve'}
          </Button>
        </div>
      }
    >
      {blocker ? (
        <>
          <div className="project-blockers-dialog-subject">{subject}</div>
          {prompt ? (
            <div className="project-blockers-dialog-question">
              <span className="project-blockers-dialog-kicker">Your decision</span>
              {prompt.question}
            </div>
          ) : null}
          {blocker.agentArgument?.trim() && blocker.detail?.reason === 'CRITERION_EXEMPTION_ARGUED' ? (
            <div className="project-blockers-dialog-evidence">
              <span className="project-blockers-dialog-kicker">Agent’s explanation</span>
              <p>{blocker.agentArgument.trim()}</p>
            </div>
          ) : null}
          {criterionVisible && blocker.criterionText?.trim() ? (
            <div className="project-blockers-dialog-evidence">
              <span className="project-blockers-dialog-kicker">Current criterion</span>
              <p>{blocker.criterionText.trim()}</p>
            </div>
          ) : null}
          {paths.length > 0 ? (
            <div className="project-blockers-dialog-evidence">
              <span className="project-blockers-dialog-kicker">Files this blocker names</span>
              <ul>
                {paths.map((path) => <li key={path}><code>{path}</code></li>)}
              </ul>
            </div>
          ) : null}
          <label className="project-blockers-dialog-label" htmlFor={fieldId}>
            {prompt ? 'What did you verify?' : 'Why is it no longer blocking?'}
          </label>
          <Input.TextArea
            id={fieldId}
            value={reason}
            maxLength={2000}
            autoSize={{ minRows: 2, maxRows: 8 }}
            onChange={(event) => setReason(event.target.value)}
          />
          {resolve.isError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 10 }}
              message="That resolution was not recorded"
              description={resolve.error instanceof Error ? resolve.error.message : undefined}
            />
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

export function ProjectBlockersCard({
  projectId,
  blockers,
  now = Date.now(),
}: {
  projectId: string;
  /** Absent from a server that predates the read. */
  blockers: ProjectBlockers | undefined;
  now?: number;
}) {
  const [resolving, setResolving] = useState<ProjectBlocker | null>(null);
  const open = blockers?.open ?? [];
  if (open.length === 0) return null;
  const latest = blockers?.resolved[0];

  return (
    <section className="project-blockers" aria-label="Blockers" style={{ marginBottom: 24 }}>
      {/* The same heading the run queue below wears, because these two are one reading — what is
          standing in the way, then what can be started. Plain, unboxed, level four: the graph,
          the chain strip and the queue beside it are all sections of this zone, not cards. */}
      <Typography.Title className="project-blockers-heading" level={4} style={{ marginBottom: 8 }}>
        <span className="project-blockers-heading-label">Blockers</span>
        <Typography.Text
          className="project-blockers-summary"
          type="secondary"
          style={{ fontSize: 12, fontWeight: 400 }}
          title={`${open.length} open`}
        >
          {' '}
          {`${open.length} open`}
        </Typography.Text>
      </Typography.Title>
      <ul className="project-blockers-list">
        {open.map((blocker) => (
          <BlockerRow
            key={blocker.id}
            blocker={blocker}
            projectId={projectId}
            now={now}
            onResolve={() => setResolving(blocker)}
          />
        ))}
      </ul>
      {blockers && blockers.resolvedCount > 0 && latest ? (
        <details className="project-blockers-resolved">
          <summary>
            {`${blockers.resolvedCount} resolved · latest: `}
            <i>{resolutionLine(latest)}</i>
          </summary>
          <ul>
            {blockers.resolved.map((blocker) => (
              <li key={blocker.id}>
                {[blockerHeadline(blocker).title, blocker.subjectTitle].filter(Boolean).join(' · ')}
                {' — '}
                {resolutionLine(blocker)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <ResolveBlockerDialog
        projectId={projectId}
        blocker={resolving}
        onClose={() => setResolving(null)}
      />
    </section>
  );
}
