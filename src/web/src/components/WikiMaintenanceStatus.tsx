import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import type { WikiMaintenanceHealth } from '@orbit/shared';
import { wikiMaintenanceParts, type WikiStatusPart } from '../lib/wikiHealth';
import { wikiSettingsPath } from '../lib/wikiReviewMode';

/**
 * The maintenance part of the status row, after the anchors (mocks 11 ② and 12 ④): each part behind its
 * own `·`, coloured by the look — amber while the run waits, red when it broke, as the session list's
 * dots are — with Set up leading to the space's Wiki settings and View run to the session of the run that
 * ended last. The words are `wikiMaintenanceParts`', which iOS says too.
 */
export function WikiMaintenanceStatus({
  health,
  spaceSlug,
  now = Date.now(),
}: {
  health: WikiMaintenanceHealth;
  spaceSlug: string;
  now?: number;
}) {
  return (
    <>
      {wikiMaintenanceParts(health, now).map((part, index) => (
        <Fragment key={index}>
          <span className="wk-sep">·</span>
          <StatusPart part={part} health={health} spaceSlug={spaceSlug} />
        </Fragment>
      ))}
    </>
  );
}

function StatusPart({ part, health, spaceSlug }: { part: WikiStatusPart; health: WikiMaintenanceHealth; spaceSlug: string }) {
  if (part.link === 'settings') {
    return <Link className="wk-maint-link" to={wikiSettingsPath(spaceSlug)}>{part.text}</Link>;
  }
  if (part.link === 'run' && health.lastRun?.sessionId) {
    return (
      <Link className="wk-maint-link" to={`/sessions/${encodeURIComponent(health.lastRun.sessionId)}`}>
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
