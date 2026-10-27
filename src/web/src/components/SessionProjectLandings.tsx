import type { JSX } from 'react';
import { SESSION_LANDINGS_COPY, type LandingsRowSummary } from '../lib/sessionProjects';
import { Glyph } from './ProjectPanoramaHeader';

/**
 * The Landings row of a project's sessions page (owner 2026-10-27, docs/mocks/landings-one-window
 * 01 b; contract §2.9 LS6, revision 28): one row under the coordinator and above the page's own
 * timeline, where the Landings group was. It wears the merged line's head — one circle with the mark
 * of the most urgent landing, the title, how long it has waited (or since the last one settled), and
 * the counts under them — and opens the project's Landings window, at its bottom.
 *
 * The caller draws nothing at all for a project that has never had a landing (`landingsRowSummary`
 * answers null): a heading over nothing would be a permanent "nothing landed" row.
 */
export function SessionProjectLandings({
  summary,
  onOpen,
}: {
  summary: LandingsRowSummary;
  onOpen: () => void;
}): JSX.Element {
  return (
    <section className="session-project-landings" aria-label={SESSION_LANDINGS_COPY.TITLE}>
      <div className="session-section-head">{SESSION_LANDINGS_COPY.TITLE}</div>
      <button type="button" className="session-row session-project-merge-row session-project-landing-row"
        data-landings-row={summary.mark} onClick={onOpen}>
        <span className={`session-project-landing-mark is-${summary.mark}`} aria-hidden="true">
          {summary.mark === 'fail' ? '✕' : summary.mark === 'ok' ? '✓' : <Glyph shape="spinner" color="currentColor" size={14} />}
        </span>
        <span className="session-project-merge-row-body">
          <span className="session-project-merge-row-head">
            <span className="session-project-merge-row-title">{SESSION_LANDINGS_COPY.TITLE}</span>
            {summary.time ? <span className="session-time">{summary.time}</span> : null}
          </span>
          <span className="session-project-merge-row-detail session-project-landings-line">{summary.line}</span>
        </span>
      </button>
    </section>
  );
}
