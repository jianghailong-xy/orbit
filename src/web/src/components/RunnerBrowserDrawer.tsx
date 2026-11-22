import { useState } from 'react';
import type { RunnerBrowserState } from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import { RUNNER_BROWSER_COPY as COPY, openRunnerBrowserTab } from '../lib/runnerBrowser';
import { VncCanvas, type Link } from './RunnerBrowserScreen';
import { Button } from './ui/Button';
import { Drawer } from './ui/Drawer';
import './RunnerBrowserDrawer.css';

/**
 * A quick look at the Orbit Cloud runner's browser from a session (docs/runner-browser-design.md §5; board
 * 02-control-view frame ③): the right-side Drawer with a noVNC canvas scaled to fit, view only. Acting in the browser
 * happens in its tab of its own (/runners/:id/browser), where the screen has room:
 *
 *   - Open in new tab opens that tab view only; Take control opens it already in control. Either closes this drawer
 *     first, and with it its stream, so the drawer and the tab never take both of the runner's two streams.
 *   - Taking control interrupts nothing (P3 = B): no request is made to the session.
 */
export function RunnerBrowserDrawer({
  runnerId,
  open,
  onClose,
  sessionId,
  state,
}: {
  runnerId: string;
  open: boolean;
  onClose: () => void;
  /** The session whose chip opened it, so its own lease reads as "this session". */
  sessionId?: string | null;
  state: RunnerBrowserState | null | undefined;
}) {
  const [link, setLink] = useState<Link>('connecting');

  const holder = state?.holderSessionId ?? null;
  const holderLine = !holder
    ? COPY.heldByNone
    : sessionId && routeId(holder) === routeId(sessionId)
      ? COPY.heldByThis
      : state?.holderTitle
        ? COPY.heldBy(state.holderTitle)
        : COPY.heldByUntitled;

  const toTab = (control: boolean) => {
    // The drawer's stream closes before the tab opens its own.
    onClose();
    openRunnerBrowserTab(runnerId, control);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      className="rb-drawer"
      title={COPY.title}
      headerActions={
        <span className="rb-head-actions">
          <Button className="rb-open-tab" onClick={() => toTab(false)}>
            <span aria-hidden>↗ </span>
            {COPY.openInNewTab}
          </Button>
          <Button variant="primary" onClick={() => toTab(true)}>
            {COPY.takeControl}
          </Button>
        </span>
      }
      footer={
        <div className="rb-foot">
          <span className="rb-view-only">{COPY.viewOnly}</span>
          <span className="rb-holder">{holderLine}</span>
          <span className="rb-scaled">{COPY.scaled}</span>
          <span className={`rb-link is-${link}`}>
            {link === 'live' ? COPY.live : link === 'connecting' ? COPY.connecting : COPY.disconnected}
          </span>
        </div>
      }
    >
      {open && <VncCanvas runnerId={runnerId} viewOnly onLink={setLink} />}
    </Drawer>
  );
}
