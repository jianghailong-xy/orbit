import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Skeleton, Tag, Typography } from 'antd';
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
      <Typography.Text type="secondary" style={{ minWidth: 132, flexShrink: 0 }}>
        {label}
      </Typography.Text>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
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
      <Typography.Text strong>{project.title}</Typography.Text>{' '}
      <Typography.Text code copyable={{ text: publicIdOf(project) }}>
        {publicIdOf(project)}
      </Typography.Text>{' '}
      <Tag aria-label={`Project status ${project.status}`} title={`Project status ${project.status}`}>
        {project.status}
      </Tag>
    </span>
  );
}

/** Why a section is empty, in a sentence. Falls back to the raw reason so a code this build has
 *  never heard of is still visible rather than silently rendering as nothing at all. */
function Absent({ reason }: { reason: string | null }) {
  return (
    <Typography.Text type="secondary">
      {reason ? labelFor(ABSENT_REASON_LABEL, reason) : 'Not reported by this server build.'}
    </Typography.Text>
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
            <Tag aria-label="Evidence only — this does not decide where the work is filed">
              {view.discovery.authority === 'EVIDENCE_ONLY' ? 'EVIDENCE ONLY' : view.discovery.authority}
            </Tag>
            {view.discovery.project ? (
              <div style={{ marginTop: 4 }}>
                <ProjectIdentity project={view.discovery.project} />
              </div>
            ) : null}
            {view.discovery.triggerEvent ? (
              <div>
                <Typography.Text type="secondary">Trigger </Typography.Text>
                <Typography.Text code>{view.discovery.triggerEvent}</Typography.Text>
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
            <Tag aria-label={`Crossing ${view.crossing.state}`}>{view.crossing.state}</Tag>
            <Typography.Text strong>
              {labelFor(CROSSING_STATE_LABEL, view.crossing.state)}
            </Typography.Text>
            <div>
              <Typography.Text type="secondary">
                {labelFor(CROSSING_STATE_MEANING, view.crossing.state)}
              </Typography.Text>
            </div>
            {view.crossing.from && view.crossing.to ? (
              <div style={{ marginTop: 4 }}>
                <ProjectIdentity project={view.crossing.from} />
                <Typography.Text type="secondary"> → </Typography.Text>
                <ProjectIdentity project={view.crossing.to} />
              </div>
            ) : null}
            {view.crossing.code ? (
              <div>
                <Typography.Text code>{view.crossing.code}</Typography.Text>{' '}
                <Typography.Text code>{view.crossing.requiredAction}</Typography.Text>
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
            <Tag aria-label={`Blocker ${view.blocker.kind}`}>{view.blocker.kind}</Tag>
            <Typography.Text code>{view.blocker.code ?? 'UNKNOWN'}</Typography.Text>{' '}
            <Typography.Text type="secondary">owner {view.blocker.owner}</Typography.Text>
            <div>{view.blocker.requiredAction}</div>
            <Typography.Text type="secondary">
              Next checked {new Date(view.blocker.nextCheckAt).toLocaleString()}
            </Typography.Text>
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
        <Skeleton active title={false} paragraph={{ rows: 3 }} />
      ) : attribution.isError ? (
        <Alert
          type="warning"
          showIcon
          message="Attribution boundary could not be loaded"
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
