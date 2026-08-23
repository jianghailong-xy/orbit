import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Spin, Typography } from 'antd';
import {
  projectPanoramaBlockingQuery,
  type ProjectBlockingItem,
} from '../lib/queries';

/**
 * "Unblock which task to release the most work" — the ranking that stands in for the DAG.
 *
 * A 118-task project drawn as nodes and edges is unreadable; this ranking is five rows whatever
 * the size of the graph, and it answers the only question the picture was being asked. It reads
 * `GET /projects/:id/panorama/blocking`, whose `downstreamBlocked` is the TRANSITIVE closure —
 * every unfinished task that waits on this one, however far down the chain.
 *
 * THE DENOMINATOR IS THE POINT. Bar length is measured against `remainingCount` — every unfinished
 * task in the project — never against the top row's value. Normalizing to the leader would make
 * every project look the same: the first bar always full, the rest relative to a number the reader
 * cannot see. Against the remaining work, a full bar means "this one task holds up nearly
 * everything left", and a short one means it does not, which is the comparison worth making. The
 * header says which track is in use so the length is never read as a share of the five shown.
 *
 * One hue, one series: magnitude is carried by LENGTH, not by colour, so there is nothing for a
 * legend to explain. `Table view` swaps the bars for a plain `<table>` — the accessibility
 * fallback, and the copyable form of the same numbers.
 *
 * Fetches its own data on purpose: the page it sits on composes five of these, and a card that
 * fetches for itself fails for itself. This one 500ing must cost the reader this ranking and
 * nothing else, which is also why every state below renders instead of throwing.
 */
export function ProjectBlockingLeaderboard({
  projectId,
  limit = 5,
}: {
  projectId: string;
  limit?: number;
}) {
  const ranking = useQuery(projectPanoramaBlockingQuery(projectId, limit));
  const [view, setView] = useState<'bars' | 'table'>('bars');
  // Which row the pointer is on, by task id rather than index, so a refetch that reorders the
  // ranking cannot leave the highlight on a different task than the one under the cursor.
  const [hovered, setHovered] = useState<string | null>(null);

  const data = ranking.data;
  const items = Array.isArray(data?.items) ? data.items : [];

  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <Typography.Title level={4} style={{ marginBottom: 8 }}>
          Unblocks the most work{' '}
          {/* Only where there are bars to read it against: on a project with no blocking at all,
              naming a track is a measurement of nothing. */}
          {data && items.length > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              track = all {data.remainingCount} remaining
            </Typography.Text>
          ) : null}
        </Typography.Title>
        {items.length > 0 ? (
          // One control, pressed or not, rather than a label that flips to "Chart view": the
          // reader who went looking for `Table view` finds the same button in the same place on
          // the way back.
          <Button
            size="small"
            aria-pressed={view === 'table'}
            onClick={() => setView((v) => (v === 'table' ? 'bars' : 'table'))}
          >
            Table view
          </Button>
        ) : null}
      </div>

      {ranking.isLoading ? (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : ranking.isError ? (
        <Alert
          type="error"
          showIcon
          message="The blocking ranking could not be read"
          description={ranking.error instanceof Error ? ranking.error.message : undefined}
          action={
            <Button size="small" danger onClick={() => void ranking.refetch()}>
              Retry
            </Button>
          }
        />
      ) : data ? (
        <>
          {/* The server truncates rather than spending an unbounded closure on a huge project, and
              says so in the body. Drawn, because the alternative is an empty ranking that reads as
              "nothing blocks anything" on the one project where the most does. */}
          {data.truncated ? (
            <Alert
              style={{ marginBottom: 12 }}
              type="warning"
              showIcon
              message="Ranking not computed"
              description={`This project has more than ${data.truncated.maxTasks} unfinished tasks (${data.truncated.reason}), so the blocking closure was skipped rather than run to a timeout.`}
            />
          ) : null}

          {items.length === 0 ? (
            !data.truncated ? (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Nothing here waits on anything else — no unfinished task in this project blocks
                another, so there is no ranking to draw.
              </Typography.Paragraph>
            ) : null
          ) : view === 'table' ? (
            <BlockingTable items={items} />
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {items.map((item) => (
                <BlockingRow
                  key={item.taskId}
                  item={item}
                  remainingCount={data.remainingCount}
                  dimmed={hovered !== null && hovered !== item.taskId}
                  onHover={() => setHovered(item.taskId)}
                  onLeave={() => setHovered(null)}
                />
              ))}
            </ol>
          )}

          {items.length > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Counts every unfinished task that waits on this one through any chain of
              prerequisites — the transitive closure, not the direct dependents.
            </Typography.Text>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * How much of the project's remaining work one task holds up, as a percentage of the bar's track.
 *
 * Exported for tests: this single expression is the card's central claim, and the denominator is
 * the thing a plausible-looking implementation gets wrong (`items[0].downstreamBlocked` reads the
 * same on the top row and differently on every other one).
 */
export function percentOfTrack(downstreamBlocked: number, remainingCount: number): number {
  if (remainingCount <= 0) return 0;
  return Math.min(100, (downstreamBlocked / remainingCount) * 100);
}

/** One task: its title on a line of its own, the bar under it, the count at the right. */
function BlockingRow({
  item,
  remainingCount,
  dimmed,
  onHover,
  onLeave,
}: {
  item: ProjectBlockingItem;
  remainingCount: number;
  dimmed: boolean;
  onHover: () => void;
  onLeave: () => void;
}) {
  const pct = percentOfTrack(item.downstreamBlocked, remainingCount);
  const reading = `${item.downstreamBlocked} of ${remainingCount} remaining tasks, ${Math.round(pct)}%`;

  return (
    <li
      data-testid="blocking-row"
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      style={{ marginBottom: 12 }}
    >
      <div
        title={item.title}
        style={{
          color: 'var(--text-1)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginBottom: 4,
        }}
      >
        {item.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* The track is every remaining task; the fill is the part of it this one task is holding
            up. A lighter step of the same hue, so the unfilled part still reads as the same scale. */}
        <div
          role="img"
          aria-label={reading}
          style={{
            flex: 1,
            height: 7,
            background: 'var(--brand-tint)',
            borderRadius: '0 3.5px 3.5px 0',
          }}
        >
          <div
            data-testid="blocking-bar"
            style={{
              width: `${pct}%`,
              height: 7,
              background: 'var(--brand)',
              borderRadius: '0 3.5px 3.5px 0',
              // Hovering one row backs the others off rather than repainting the hovered one: the
              // hue means "this series", so nothing here may say anything by changing colour.
              opacity: dimmed ? 0.35 : 1,
              transition: 'opacity 120ms ease',
            }}
          />
        </div>
        <span
          style={{
            minWidth: 44,
            textAlign: 'right',
            fontSize: 22,
            lineHeight: 1,
            color: 'var(--text-1)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {item.downstreamBlocked}
        </span>
      </div>
    </li>
  );
}

/** The same five numbers as a table: what a screen reader can walk, and what a reader can copy. */
function BlockingTable({ items }: { items: ProjectBlockingItem[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left', padding: '4px 8px 4px 0', color: 'var(--text-2)' }}>
            Task
          </th>
          <th style={{ textAlign: 'right', padding: '4px 0', color: 'var(--text-2)' }}>
            Downstream blocked
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.taskId} style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <td style={{ padding: '6px 8px 6px 0' }}>{item.title}</td>
            <td
              style={{
                padding: '6px 0',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {item.downstreamBlocked}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
