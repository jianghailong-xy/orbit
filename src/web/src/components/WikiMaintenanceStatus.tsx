import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import type { WikiSpaceHealth } from '@orbit/shared';
import { wikiStatusParts, type WikiStatusPart } from '../lib/wikiHealth';
import { wikiSettingsPath } from '../lib/wikiReviewMode';
import { wikiActivityRunPath } from '../lib/wikiRuns';

/**
 * The maintenance part of the status row, after the anchors (mocks 11 ② and 12 ④): each part behind its
 * own `·`, coloured by the look — amber while the run waits, red when it broke, as the session list's
 * dots are — with Set up leading to the space's Wiki settings and View run to the session of the run that
 * ended last. The words are `wikiStatusParts`', which iOS says too.
 *
 * While the server executes the account's wiki the line also says why its runs do not move (mock 35 ⑥), and a
 * run the server's job made has no session: its View run opens the run's row on Activity instead.
 *
 * After them, what the latest run read of the repository (docs/wiki-repo-tiers-design.md §7.2, mock 44 ⑤): a phone's
 * line says its short words, a wide one the whole sentence and `Fix in Settings`. When the two differ both are drawn,
 * and the stylesheet shows the one the width asks for.
 */
export function WikiMaintenanceStatus({
  health,
  spaceSlug,
  now = Date.now(),
}: {
  health: WikiSpaceHealth;
  spaceSlug: string;
  now?: number;
}) {
  const wide = wikiStatusParts(health, now);
  const narrow = wikiStatusParts(health, now, true);
  const line = (parts: WikiStatusPart[]) =>
    parts.map((part, index) => (
      <Fragment key={index}>
        <span className="wk-sep">·</span>
        <StatusPart part={part} health={health} spaceSlug={spaceSlug} />
      </Fragment>
    ));
  if (JSON.stringify(wide) === JSON.stringify(narrow)) return <>{line(wide)}</>;
  return (
    <>
      <span className="wk-maint-wide">{line(wide)}</span>
      <span className="wk-maint-narrow">{line(narrow)}</span>
    </>
  );
}

function StatusPart({ part, health, spaceSlug }: { part: WikiStatusPart; health: WikiSpaceHealth; spaceSlug: string }) {
  if (part.link === 'settings') {
    return (
      <Link
        className={part.tone === 'muted' ? 'wk-maint-link wk-maint-link--muted' : 'wk-maint-link'}
        to={wikiSettingsPath(spaceSlug)}
        title={part.hint}
      >
        {part.text}
      </Link>
    );
  }
  const lastRun = health.maintenance.lastRun;
  if (part.link === 'run' && lastRun?.jobId) {
    return <Link className="wk-maint-link" to={wikiActivityRunPath(spaceSlug, lastRun.jobId)}>{part.text}</Link>;
  }
  if (part.link === 'run' && lastRun?.sessionId) {
    return (
      <Link className="wk-maint-link" to={`/sessions/${encodeURIComponent(lastRun.sessionId)}`}>
        {part.text}
      </Link>
    );
  }
  return (
    <span className={`wk-maint wk-maint--${part.tone}`}>
      {part.mark === 'dot' && <span className="wk-maint-dot" aria-hidden="true" />}
      {part.mark === 'spin' && <span className="wk-maint-spin" aria-hidden="true" />}
      {part.strong ? <b>{part.text}</b> : part.text}
      {part.mark === 'check' && <span className="wk-maint-ok">✓</span>}
    </span>
  );
}
