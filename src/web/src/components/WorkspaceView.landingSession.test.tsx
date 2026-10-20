import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WHERE THE LANDING SESSION PAGE IS CHOSEN, AND BY WHAT.
 *
 * The console's session route is one component: `/sessions/:id` mounts `WorkspaceView`, which
 * draws a conversation. A landing session must swap the whole right pane for its own reader —
 * status card, timeline, no composer — while the session list stays where it is. The choice is the
 * half a render of `LandingSessionView` on its own cannot answer, so it is read from the
 * composition, the way the pending strip's placement is.
 *
 * The rule that matters most is the FLAG: a list row carries `kind: 'session' | 'project'`, and a
 * landing's detail carries `sessionKind: 'LANDING'` (contract §2.9 LS6). Choosing by the list's
 * `kind` would draw every conversation as a landing — or, more likely, no landing at all.
 */

const SOURCE = readFileSync(new URL('./WorkspaceView.tsx', import.meta.url), 'utf8');

describe('the session route picks the landing renderer by sessionKind', () => {
  it('reads the detail’s sessionKind, never a list row’s kind', () => {
    expect(SOURCE).toContain('isLandingSessionDetail(detailForSelected)');
    expect(SOURCE).toContain("if (detail?.id === selectedId && detail.sessionKind === 'LANDING') return false;");
    // The list key is `kind` and means something else; nothing in this view may route on it.
    expect(SOURCE).not.toMatch(/\.kind\s*===\s*'LANDING'/);
  });

  it('mounts the landing page inside the workspace pane, in place of the conversation', () => {
    expect(SOURCE).toContain('<LandingSessionView');
    expect(SOURCE).toContain('sessionId={selectedId!}');
    expect(SOURCE).toContain('detail={landingDetail}');
    const landing = SOURCE.indexOf('<LandingSessionView');
    const header = SOURCE.indexOf('<div className="workspace-header">');
    const composer = SOURCE.indexOf('<div className="workspace-composer">');
    expect(landing).toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(-1);
    // The page is the pane's alternative: it is mounted before the conversation's header, and it
    // is not a sibling that would leave the composer under it.
    expect(landing).toBeLessThan(header);
    expect(landing).toBeLessThan(composer);
  });

  it('opens no transcript stream and reads no event page for a landing', () => {
    // LS1/LS6: a LANDING session never writes run_event and sends no session events; subscribing
    // would be a stream that can only ever say nothing.
    expect(SOURCE).toContain('if (!selectedId || landingSession)');
    expect(SOURCE).toContain('[selectedId, landingSession]');
  });

  it('lets the landing page own its own polling', () => {
    // The shell's 5 s conversation sweep would over-poll a queued landing and never stop on a
    // settled one; §2.7a's 4 s / 15 s / stop is `LandingSessionView`'s.
    const page = readFileSync(new URL('./LandingSessionView.tsx', import.meta.url), 'utf8');
    expect(page).toContain('landingRefetchMs');
  });
});
