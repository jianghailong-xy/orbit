import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Tag, Typography } from 'antd';
import { api } from '../api';

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
  /** The criterion that task is filed against, as it stands today. */
  criterionOrdinal: number | null;
  criterionRevision: number | null;
  detail: { reason?: string; paths?: string[] } & Record<string, unknown>;
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
    title: 'It argues a criterion doesn’t apply to it',
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
  const words = blocker.kind.toLowerCase().split('_').filter(Boolean).join(' ');
  return {
    ...(OWNER_TAG[blocker.owner] ?? OWNER_TAG.SYSTEM),
    title: words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : blocker.kind,
  };
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

function pathsOf(blocker: ProjectBlocker): string[] {
  const paths = blocker.detail?.paths;
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
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

function BlockerRow({
  blocker,
  now,
  onResolve,
}: {
  blocker: ProjectBlocker;
  now: number;
  onResolve: () => void;
}) {
  const headline = blockerHeadline(blocker);
  const subject = blockerSubjectLine(blocker);
  const paths = pathsOf(blocker);
  const pathsLine = blockerPathsLine(paths);
  return (
    <li className="project-blockers-row">
      <div className="project-blockers-main">
        <div className="project-blockers-headline">
          <Tag color={headline.color}>{headline.tag}</Tag>
          <span>{headline.title}</span>
        </div>
        {subject ? <div className="project-blockers-subject">{subject}</div> : null}
        <div className="project-blockers-action">{blocker.requiredAction}</div>
        {pathsLine ? (
          <div className="project-blockers-paths" title={paths.join('\n')}>
            {pathsLine}
          </div>
        ) : null}
      </div>
      <div className="project-blockers-side">
        <time className="project-blockers-age" dateTime={blocker.firstSeenAt}>
          {sinceLabel(blocker.firstSeenAt, now)}
        </time>
        <Button size="small" onClick={onResolve}>
          Resolve…
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

  return (
    <Modal
      open={blocker !== null}
      title="Resolve this blocker"
      closable={false}
      onCancel={cancel}
      footer={
        <div className="project-blockers-dialog-foot">
          <span className="project-blockers-dialog-note">Recorded with your name and this reason</span>
          <Button onClick={cancel} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button
            type="primary"
            disabled={trimmed === ''}
            loading={resolve.isPending}
            onClick={() => {
              if (blocker && trimmed !== '') resolve.mutate({ blocker, reason: trimmed });
            }}
          >
            Resolve
          </Button>
        </div>
      }
    >
      {blocker ? (
        <>
          <div className="project-blockers-dialog-subject">{subject}</div>
          <label className="project-blockers-dialog-label" htmlFor={fieldId}>
            Why is it no longer blocking?
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
