import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { showsConversation } from '../lib/paneTransition';

/**
 * WHERE A LANDING IS OPENED, AND BY WHAT.
 *
 * The console's session route is one component: `/sessions/:id` mounts `WorkspaceView`, which
 * draws a conversation. A landing session swaps the whole right pane for its project's Landings
 * window (owner 2026-10-27, contract §2.9 LS6 revision 28) — focused on that landing — while the
 * session list stays where it is; the window also has an address of its own,
 * `/projects/<id>/landings`. The choice is the half a render of `ProjectLandingsWindow` on its own
 * cannot answer, so it is read from the composition, the way the pending strip's placement is.
 *
 * The rule that matters most is the FLAG: a list row carries `kind: 'session' | 'project'`, and a
 * landing's detail carries `sessionKind: 'LANDING'` (contract §2.9 LS6). Choosing by the list's
 * `kind` would draw every conversation as a landing — or, more likely, no landing at all.
 */

const SOURCE = readFileSync(new URL('./WorkspaceView.tsx', import.meta.url), 'utf8');

describe('the session route opens a landing in its project’s Landings window', () => {
  it('reads the detail’s sessionKind, never a list row’s kind', () => {
    expect(SOURCE).toContain('isLandingSessionDetail(detailForSelected)');
    expect(SOURCE).toContain("if (detail?.id === selectedId && detail.sessionKind === 'LANDING') return false;");
    // The list key is `kind` and means something else; nothing in this view may route on it.
    expect(SOURCE).not.toMatch(/\.kind\s*===\s*'LANDING'/);
  });

  it('mounts the window inside the workspace pane, in place of the conversation, focused on the landing', () => {
    expect(SOURCE).toContain('<ProjectLandingsWindow');
    expect(SOURCE).toContain('focusId={landingsProjectId ? null : selectedId}');
    expect(SOURCE).toContain("const landingsProjectId = routeId(useMatch('/projects/:id/landings')?.params.id);");
    const landing = SOURCE.indexOf('<ProjectLandingsWindow');
    const header = SOURCE.indexOf('<div className="workspace-header">');
    const composer = SOURCE.indexOf('<div className="workspace-composer">');
    expect(landing).toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(-1);
    // The window is the pane's alternative: it is mounted before the conversation's header, and it
    // is not a sibling that would leave the composer under it.
    expect(landing).toBeLessThan(header);
    expect(landing).toBeLessThan(composer);
    // The single landing page is gone: every landing id opens the window.
    expect(SOURCE).not.toContain('LandingSessionView');
  });

  it('gives the window its own address, which a phone shows in the conversation’s place', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<Route path="projects/:id/landings" />');
    expect(showsConversation('/projects/p1/landings')).toBe(true);
    expect(showsConversation('/projects/p1')).toBe(false);
    // Nothing is composed under the window.
    expect(SOURCE).toContain('!selectedId && !landingsProjectId &&');
  });

  it('opens no transcript stream and reads no event page for a landing', () => {
    // LS1/LS6: a LANDING session never writes run_event and sends no session events; subscribing
    // would be a stream that can only ever say nothing.
    expect(SOURCE).toContain('if (!selectedId || landingSession)');
    expect(SOURCE).toContain('[selectedId, landingSession]');
  });

  it('lets the window own its landings’ polling', () => {
    // The shell's 5 s conversation sweep would over-poll a queued landing and never stop on a
    // settled one; §2.7a's 4 s / 15 s / stop is each card's, and a settled row never polls.
    const window = readFileSync(new URL('./ProjectLandingsWindow.tsx', import.meta.url), 'utf8');
    expect(window).toContain('return view ? landingRefetchMs(view) : 15_000;');
    expect(window).toContain('staleTime: Number.POSITIVE_INFINITY,');
  });
});
