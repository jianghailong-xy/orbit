import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { copyText } from '../lib/clipboard';
import { taskAttributionQuery } from '../lib/queries';
import {
  ABSENT_REASON_LABEL,
  CROSSING_STATE_LABEL,
  CROSSING_STATE_MEANING,
  labelFor,
  publicIdOf,
  type AttributionProjectRef,
  type TaskAttribution,
} from '../lib/attribution';
import { MOVE_TASK_STATE_MEANING } from './ProjectCrossingsCard';
import { Alert } from './ui/Alert';
import { Badge } from './ui/Badge';
import { Card } from './ui/Card';
import { Skeleton } from './ui/Skeleton';
import { Tooltip } from './ui/Tooltip';
import './ui/Typography.css';

/**
 * Unit L7: where this task's work counts, and everything that follows from that.
 *
 * The reason this card exists is that every fact on it already existed and none of it was
 * readable. A task's project was an id on a page that never showed it; "where this work was
 * noticed" was four columns nothing read back; a PASS from before a reopen looked exactly like one
 * from after. So the boundary was only ever met by being refused by it — which is the wrong moment
 * to learn where your work is being filed.
 *
 * THREE RULES THIS FILE KEEPS
 *
 *  - **Nothing here is decided here.** Every value is computed by the server
 *    (`project-attribution-surface.ts`) and rendered. The one thing this file owns is what a code
 *    is CALLED, and an unknown code renders as itself rather than as blank.
 *  - **No state is carried by colour or by prose alone** (AC5). Every chip has a word, every code
 *    is printed as the code, and a stale conclusion says WHICH of the two ways it went stale.
 *  - **An absent fact says why it is absent.** "No crossing touches this task" and "this
 *    build cannot tell you" are different answers, and an empty section says neither.
 */

/** A labelled line. `title`/`aria-label` carry the long form when the value is an id or a chip. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', alignItems: 'flex-start' }}>
      <span className="orbit-typography orbit-typography-secondary" style={{ minWidth: 132, flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** How long the copy mark says Copied (the replaced text control's own beat). */
const COPIED_MS = 3000;

/** The id, in code, with its copy mark inside the code box after it: a link-coloured icon that says
 *  what it does on hover, and turns into a check for a few seconds once the id is on the clipboard. */
function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () =>
    void copyText(id).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    });
  const label = copied ? 'Copied' : 'Copy';
  return (
    <span className="orbit-typography">
      <code>
        {id}
        <span className="orbit-typography-actions">
          <Tooltip content={label}>
            <button
              type="button"
              className={`orbit-typography-copy${copied ? ' orbit-typography-copy-success' : ''}`}
              aria-label={label}
              onClick={copy}
            >
              {copied ? <CheckOutlined aria-hidden /> : <CopyOutlined aria-hidden />}
            </button>
          </Tooltip>
        </span>
      </code>
    </span>
  );
}

/**
 * A project, as the reader has to be able to act on it: the title they recognise and the Base62 id
 * they paste. Both, always — a title alone cannot be looked up and an id alone cannot be read, and
 * AC1 asks for the pair before anything is submitted.
 */
export function ProjectIdentity({ project }: { project: AttributionProjectRef }) {
  return (
    <span>
      <span className="orbit-typography"><strong>{project.title}</strong></span>{' '}
      <CopyableId id={publicIdOf(project)} />{' '}
      <Badge aria-label={`Project status ${project.status}`} title={`Project status ${project.status}`}>
        {project.status}
      </Badge>
    </span>
  );
}

/** Why a section is empty, in a sentence. Falls back to the raw reason so a code this build has
 *  never heard of is still visible rather than silently rendering as nothing at all. */
function Absent({ reason }: { reason: string | null }) {
  return (
    <span className="orbit-typography orbit-typography-secondary">
      {reason ? labelFor(ABSENT_REASON_LABEL, reason) : 'Not reported by this server build.'}
    </span>
  );
}

/** The body, split out so a test can render it against a fixture without a query client. */
export function TaskAttributionBody({ view }: { view: TaskAttribution }) {
  return (
    <div>
      <Row label="Counts towards">
        {view.owning ? (
          <ProjectIdentity project={view.owning} />
        ) : (
          <Absent reason={view.owningAbsentReason} />
        )}
      </Row>

      <Row label="Noticed in">
        {view.discovery.recorded ? (
          <div>
            {/* SC7, on the screen and not only in the payload: this is where the work was
                FOUND, and finding it grants nothing about where it may be filed. The chip is
                rendered from the server's own `authority` value so it cannot be dropped by a
                client that forgets the rule. */}
            <Badge aria-label="Evidence only — this does not decide where the work is filed">
              {view.discovery.authority === 'EVIDENCE_ONLY' ? 'EVIDENCE ONLY' : view.discovery.authority}
            </Badge>
            {view.discovery.project ? (
              <div style={{ marginTop: 4 }}>
                <ProjectIdentity project={view.discovery.project} />
              </div>
            ) : null}
            {view.discovery.triggerEvent ? (
              <div>
                <span className="orbit-typography orbit-typography-secondary">Trigger </span>
                <span className="orbit-typography"><code>{view.discovery.triggerEvent}</code></span>
              </div>
            ) : null}
            {view.discovery.task ? <div>Task: {view.discovery.task.title}</div> : null}
            {view.discovery.session ? (
              <div>Session: {view.discovery.session.title ?? 'untitled'}</div>
            ) : null}
          </div>
        ) : (
          <Absent reason={view.discovery.absentReason} />
        )}
      </Row>

      <Row label="Crossing">
        {view.crossing ? (
          <div>
            <Badge aria-label={`Crossing ${view.crossing.state}`}>{view.crossing.state}</Badge>
            <span className="orbit-typography">
              <strong>{labelFor(CROSSING_STATE_LABEL, view.crossing.state)}</strong>
            </span>
            <div>
              {/* A request to MOVE a task that already exists is read as a move: the task stays
                  in its project until the owner answers, and confirming moves it, so a filing's
                  "not filed anywhere" would be false of it. The crossings card's own words, so
                  the two places that show the same request say the same thing. */}
              <span className="orbit-typography orbit-typography-secondary">
                {labelFor(
                  view.crossing.kind === 'MOVE_TASK' ? MOVE_TASK_STATE_MEANING : CROSSING_STATE_MEANING,
                  view.crossing.state,
                )}
              </span>
            </div>
            {view.crossing.from && view.crossing.to ? (
              <div style={{ marginTop: 4 }}>
                <ProjectIdentity project={view.crossing.from} />
                <span className="orbit-typography orbit-typography-secondary"> → </span>
                <ProjectIdentity project={view.crossing.to} />
              </div>
            ) : null}
            {view.crossing.code ? (
              <div>
                <span className="orbit-typography"><code>{view.crossing.code}</code></span>{' '}
                <span className="orbit-typography"><code>{view.crossing.requiredAction}</code></span>
              </div>
            ) : null}
          </div>
        ) : (
          <Absent reason={view.crossingAbsentReason} />
        )}
      </Row>

      <Row label="Blocked by">
        {view.blocker ? (
          <div>
            <Badge aria-label={`Blocker ${view.blocker.kind}`}>{view.blocker.kind}</Badge>
            <span className="orbit-typography"><code>{view.blocker.code ?? 'UNKNOWN'}</code></span>{' '}
            <span className="orbit-typography orbit-typography-secondary">owner {view.blocker.owner}</span>
            <div>{view.blocker.requiredAction}</div>
            <span className="orbit-typography orbit-typography-secondary">
              Next checked {new Date(view.blocker.nextCheckAt).toLocaleString()}
            </span>
          </div>
        ) : (
          <Absent reason={view.blockerAbsentReason} />
        )}
      </Row>
    </div>
  );
}

/**
 * The card, fetching its own read.
 *
 * A server that does not know this route answers 404, and that is drawn as "this build does not
 * report it" rather than as an error the reader can act on — a mixed-version deployment must not
 * make a task page look broken (AC3).
 */
export function TaskAttributionCard({ taskId }: { taskId: string }) {
  const attribution = useQuery({ ...taskAttributionQuery(taskId), enabled: Boolean(taskId) });
  return (
    <Card title="Attribution" size="small" style={{ marginTop: 16 }}>
      {attribution.isPending ? (
        <Skeleton rows={3} />
      ) : attribution.isError ? (
        <Alert
          type="warning"
          title="Attribution boundary could not be loaded"
          description={
            attribution.error instanceof Error ? attribution.error.message : undefined
          }
        />
      ) : attribution.data ? (
        <TaskAttributionBody view={attribution.data} />
      ) : null}
    </Card>
  );
}
