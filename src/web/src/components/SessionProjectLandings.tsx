import { useState, type JSX } from 'react';
import { RightOutlined } from '@ant-design/icons';
import {
  SESSION_LANDINGS_COPY,
  landingEarlierLine,
  type LandingGroup,
  type LandingGroupRow,
} from '../lib/sessionProjects';

/**
 * The Landings group of a project's sessions page (owner 2026-10-19, board v4 04 c1; contract §2.9
 * LS6): the landings waiting on a decision and the ones that settled in the last day, under the
 * coordinator and above the page's own timeline.
 *
 * Each row wears the merged line's head — a mark that says how it ended, the title, how long it has
 * waited or how long ago it settled, and one line under them saying the outcome and who holds it —
 * and opens the landing session itself. A landing still in flight is not here (it is on the Landing
 * card), and neither is a round of merging that merged (the timeline already has its own row).
 * Everything older folds into one line that opens.
 *
 * The group draws nothing at all when it has nothing to list, which is the caller's decision: an
 * empty heading over a project with no landings would be a permanent "nothing landed" row.
 */
export function SessionProjectLandings({
  group,
  onOpen,
}: {
  group: LandingGroup;
  onOpen: (landingSessionId: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // A closed fold that counts landings wears v4 04 c1's green ✓. A bare `Earlier`, over rows neither
  // count names (cancelled, handled, declined…), wears it grey, as iOS and Android draw a closed fold.
  const bare = group.earlier?.landed === 0 && group.earlier.nothing === 0;
  return (
    <section className="session-project-landings" aria-label={SESSION_LANDINGS_COPY.TITLE}
      data-landings={group.waiting.length + group.settled.length}>
      <div className="session-section-head">{SESSION_LANDINGS_COPY.TITLE}</div>
      {group.waiting.map((row) => (
        <LandingGroupRowView key={row.id} row={row} onOpen={onOpen} />
      ))}
      {group.settled.map((row) => (
        <LandingGroupRowView key={row.id} row={row} onOpen={onOpen} />
      ))}
      {group.earlier ? (
        <>
          <button type="button" className="session-project-landing-fold"
            aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            <span className={`session-project-landing-mark is-${expanded || bare ? 'quiet' : 'ok'}`} aria-hidden="true">
              {expanded ? '◌' : '✓'}
            </span>
            <span className="session-project-landing-fold-text">{landingEarlierLine(group.earlier)}</span>
            <RightOutlined className={`session-project-landing-chev${expanded ? ' open' : ''}`} aria-hidden />
          </button>
          {expanded ? group.older.map((row) => (
            <LandingGroupRowView key={row.id} row={row} onOpen={onOpen} />
          )) : null}
        </>
      ) : null}
    </section>
  );
}

/** One landing: the mark that says how it stands, its title, its age and one line under both. */
function LandingGroupRowView({
  row,
  onOpen,
}: {
  row: LandingGroupRow;
  onOpen: (landingSessionId: string) => void;
}): JSX.Element {
  const mark = row.tone === 'fail' ? '✕' : row.tone === 'ok' ? '✓' : row.tone === 'merge' ? '⇢' : '◌';
  return (
    <button type="button" className="session-row session-project-merge-row session-project-landing-row"
      data-landing-row={row.id} onClick={() => onOpen(row.id)}>
      <span className={`session-project-landing-mark is-${row.tone}`} aria-hidden="true">{mark}</span>
      <span className="session-project-merge-row-body">
        <span className="session-project-merge-row-head">
          <span className="session-project-merge-row-title">{row.title}</span>
          {row.time ? <span className="session-time">{row.time}</span> : null}
        </span>
        <span className="session-project-merge-row-detail">{row.detail}</span>
      </span>
    </button>
  );
}
