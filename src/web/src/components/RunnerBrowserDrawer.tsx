import { useEffect, useRef, useState } from 'react';
import type { RunnerBrowserState } from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import { RUNNER_BROWSER_COPY as COPY, loadVnc, runnerBrowserVncUrl, type VncClient } from '../lib/runnerBrowser';
import { Button } from './ui/Button';
import { Drawer } from './ui/Drawer';
import './RunnerBrowserDrawer.css';

type Link = 'connecting' | 'live' | 'disconnected';

/**
 * The Orbit Cloud runner's browser, live (docs/runner-browser-design.md §5, board frames 5–7 and 9): the right-side
 * Drawer with a noVNC canvas scaled to fit, on the runner's viewer WebSocket.
 *
 *   - View only by default from a session: noVNC's viewOnly drops every pointer and key event, so nothing reaches the
 *     runner. Take control turns it off; the header then says the agent keeps running, and the canvas gets an
 *     orange outline.
 *   - Taking control interrupts nothing (P3 = B): the input goes over this stream straight to the runner's display,
 *     and no request is made to the session. Hand back (from a session) or Done (from Settings) only turns viewOnly
 *     back on, and also sends nothing to the agent; Done closes the drawer, as the owner came there to sign in.
 *   - The footer says who holds the browser, from the runner's last report.
 */
export function RunnerBrowserDrawer({
  runnerId,
  open,
  onClose,
  from,
  sessionId,
  state,
}: {
  runnerId: string;
  open: boolean;
  onClose: () => void;
  /** Where it was opened: a session's Browser chip (view only, Hand back) or Settings (in control, Done). */
  from: 'session' | 'settings';
  /** The session whose chip opened it, so its own lease reads as "this session". */
  sessionId?: string | null;
  state: RunnerBrowserState | null | undefined;
}) {
  const [control, setControl] = useState(from === 'settings');
  const [link, setLink] = useState<Link>('connecting');
  // Each opening starts where its door starts: view only from a session, in control from Settings.
  useEffect(() => {
    if (open) setControl(from === 'settings');
  }, [open, from]);

  const holder = state?.holderSessionId ?? null;
  const holderLine = !holder
    ? COPY.heldByNone
    : sessionId && routeId(holder) === routeId(sessionId)
      ? COPY.heldByThis
      : state?.holderTitle
        ? COPY.heldBy(state.holderTitle)
        : COPY.heldByUntitled;

  const title = control ? (from === 'session' ? COPY.controllingFromSession : COPY.controlling) : COPY.title;
  const actions = control ? (
    <Button
      className="rb-release"
      onClick={() => {
        setControl(false);
        if (from === 'settings') onClose();
      }}
    >
      {from === 'session' ? COPY.handBack : COPY.done}
    </Button>
  ) : (
    <span className="rb-head-actions">
      <span className="rb-view-only">{COPY.viewOnly}</span>
      <Button variant="primary" onClick={() => setControl(true)}>
        {COPY.takeControl}
      </Button>
    </span>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      className={`rb-drawer${control ? ' is-controlling' : ''}`}
      title={title}
      headerActions={actions}
      // In control, Escape and clicks belong to the runner's browser.
      closeOnOutsideClick={!control}
      closeOnEscape={!control}
      footer={
        <div className="rb-foot">
          <span className="rb-holder">{control && from === 'session' ? COPY.inputGoes : holderLine}</span>
          <span className="rb-scaled">{COPY.scaled}</span>
          <span className={`rb-link is-${link}`}>
            {link === 'live' ? COPY.live : link === 'connecting' ? COPY.connecting : COPY.disconnected}
          </span>
        </div>
      }
    >
      {open && <VncCanvas runnerId={runnerId} viewOnly={!control} onLink={setLink} />}
    </Drawer>
  );
}

/** noVNC on the runner's viewer route. The stream opens once per mount; viewOnly changes it in place. */
export function VncCanvas({
  runnerId,
  viewOnly,
  onLink,
}: {
  runnerId: string;
  viewOnly: boolean;
  onLink: (link: Link) => void;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const client = useRef<VncClient | null>(null);
  const viewOnlyNow = useRef(viewOnly);
  viewOnlyNow.current = viewOnly;
  const onLinkNow = useRef(onLink);
  onLinkNow.current = onLink;

  useEffect(() => {
    let gone = false;
    onLinkNow.current('connecting');
    void loadVnc()
      .then((RFB) => {
        if (gone || !screen.current) return;
        const rfb = new RFB(screen.current, runnerBrowserVncUrl(runnerId), { shared: true });
        rfb.viewOnly = viewOnlyNow.current;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        // The letterbox around the picture scaled to fit reads as the drawer's own surface, not noVNC's dark grey.
        rfb.background = 'var(--bg-sunken)';
        rfb.addEventListener('connect', () => onLinkNow.current('live'));
        rfb.addEventListener('disconnect', () => onLinkNow.current('disconnected'));
        client.current = rfb;
      })
      .catch(() => {
        if (!gone) onLinkNow.current('disconnected');
      });
    return () => {
      gone = true;
      // Input stops before the stream closes, so nothing typed while it closes reaches the runner.
      if (client.current) client.current.viewOnly = true;
      client.current?.disconnect();
      client.current = null;
    };
  }, [runnerId]);

  useEffect(() => {
    const rfb = client.current;
    if (!rfb) return;
    rfb.viewOnly = viewOnly;
    if (!viewOnly) rfb.focus();
  }, [viewOnly]);

  return <div ref={screen} className={`rb-screen${viewOnly ? '' : ' is-controlling'}`} data-testid="runner-browser-screen" />;
}
