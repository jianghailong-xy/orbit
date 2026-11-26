// The Orbit Cloud runner's browser, as the web reads it (docs/runner-browser-design.md §5; P3 = B shared input,
// P5 = web only). The server answers GET /runners/:id/browser with 404 while its browser switch is off, and for
// any runner that is not the caller's own managed one: both read here as "no browser", so nothing is drawn.

import { queryOptions } from '@tanstack/react-query';
import type { RunnerBrowserClearResponse, RunnerBrowserState } from '@orbit/shared';
import { api, ApiError, getToken } from '../api';

export const RUNNER_BROWSER_COPY = {
  title: 'Browser',
  viewOnly: 'View only',
  takeControl: 'Take control',
  done: 'Done',
  controlling: 'You are controlling the browser',
  agentKeepsRunning: 'the agent keeps running',
  watching: 'Watching the browser',
  usedBy: 'used by',
  heldByNone: 'Not in use by any session',
  heldBy: (title: string) => `Used by “${title}” · it keeps running`,
  heldByUntitled: 'Used by another session · it keeps running',
  untitledSession: 'another session',
  fit: 'Fit',
  actualSize: '100%',
  size: (percent: number | null) => `1280 × 800${percent ? ` · ${percent}%` : ''}`,
  pasteHint: (mac: boolean) => (mac ? 'Paste with ⌘V' : 'Paste with Ctrl+V'),
  pasting: 'Pasting…',
  pasteTooLarge: 'The text is too long to paste (more than 64 KB)',
  pasteNoAnswer: 'The paste did not reach the runner',
  tabTitle: 'Browser · Orbit Cloud',
  live: 'Live',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  section: 'Browser',
  rowTitle: 'Browser',
  idle: 'Idle · not running',
  running: 'Running',
  runningHeldBy: (title: string) => `Running · used by “${title}”`,
  unknown: 'Not reported yet',
  openBrowser: 'Open browser',
  savedLogins: 'Saved logins',
  savedLoginsLine: 'Sites you sign in to here stay signed in on this runner. Agents on this runner can use them.',
  clear: 'Clear saved logins',
  clearTitle: 'Clear saved logins?',
  clearBody:
    'This stops the browser on this runner and deletes its profile. Every site signed in to here is signed out, for you and for the agents.',
  clearConfirm: 'Clear',
  clearAsked: 'Saved logins will be cleared when the runner next checks in',
  clearPending: 'Clearing when the runner next checks in…',
  clearFailed: "Couldn't clear saved logins",
  // The sign-in request's banner above the tab's bar (board 03-agent-tools frame ①, notes ④ ⑤).
  signInAsked: (site: string, title: string | null) => (title ? `Sign in to ${site}, asked by “${title}”` : `Sign in to ${site}`),
  signedIn: 'I’m signed in',
  signedInFailed: "Couldn't send your answer",
  // An engine sign-in this tab saw going through the runner's browser, and then fail: the card says so in the tab
  // the owner left, so this one says it too instead of staying on the vendor's last page.
  engineSignInFailed: (engine: string) => `Couldn't sign in to ${engine}`,
  engineSignInRetry: 'Try again from the sign-in card.',
} as const;

/** `GET /runners/:id/browser`, or null when the server has no browser for it (the switch off answers 404). */
export const runnerBrowserQuery = (runnerId: string) =>
  queryOptions({
    queryKey: ['runner-browser', runnerId],
    queryFn: async (): Promise<RunnerBrowserState | null> => {
      try {
        return await api<RunnerBrowserState>(`/runners/${runnerId}/browser`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    // The state comes from the runner's heartbeat; reading it more often than that shows nothing new.
    refetchInterval: 15_000,
    retry: false,
    // The browser is the runner's: its heartbeat moves the workspace it serves.
    meta: { entities: ['workspace'] },
  });

/** `POST /runners/:id/browser/clear`: Clear saved logins, carried out at the runner's next heartbeat. */
export const clearRunnerBrowser = (runnerId: string) =>
  api<RunnerBrowserClearResponse>(`/runners/${runnerId}/browser/clear`, { method: 'POST' });

/** The viewer's WebSocket: the web login rides `access_token`, as a browser's WebSocket cannot set a header. */
export function runnerBrowserVncUrl(runnerId: string, origin: Location = window.location): string {
  const scheme = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${origin.host}/api/runners/${runnerId}/browser/vnc?access_token=${encodeURIComponent(getToken() ?? '')}`;
}

/** The largest paste the server takes, in bytes of UTF-8 (browser-viewer.ts, MAX_PASTE_BYTES). */
export const MAX_PASTE_BYTES = 64 << 10;

/** The runner browser's tab of its own (board 02-control-view, option C): `/runners/:id/browser`. */
export function runnerBrowserTabPath(runnerId: string, control = false): string {
  return `/runners/${runnerId}/browser${control ? '?control=1' : ''}`;
}

/**
 * Opens the runner's browser in its tab, already in control or view only. One tab per runner (a named window), so
 * pressing twice does not take both of the runner's two streams. Called on the click, so no pop-up blocker stops it.
 */
export function openRunnerBrowserTab(runnerId: string, control: boolean): Window | null {
  return window.open(runnerBrowserTabPath(runnerId, control), `orbit-browser-${runnerId}`);
}

/** Whether the viewer runs on a Mac (or an iPad), whose paste key is ⌘V. */
export const isMacLike = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/**
 * What the viewer says over its stream besides RFB, as text messages of JSON (browser-viewer.ts): whether it is in
 * control, and a paste; the server answers each paste.
 */
export type ViewerMessage = { type: 'control'; on: boolean } | { type: 'paste'; id: number; text: string };
export type ViewerAnswer = { type: 'pasted'; id: number; error?: string };

/** The part of noVNC's RFB this viewer uses (@novnc/novnc ships no types). */
export interface VncClient {
  viewOnly: boolean;
  scaleViewport: boolean;
  clipViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  /** The CSS background around the scaled picture. */
  background: string;
  addEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
  /** Text copied in the remote (RFB cut text, Latin-1), as `detail.text`. */
  addEventListener(type: 'clipboard', listener: (event: CustomEvent<{ text: string }>) => void): void;
  disconnect(): void;
  focus(): void;
}
/** noVNC's RFB, given the viewer's own WebSocket: it then carries the viewer's text messages too. */
export type VncClientClass = new (target: HTMLElement, channel: WebSocket, options?: { shared?: boolean }) => VncClient;

/** noVNC, loaded only when a viewer opens: its module probes the browser's codecs at load. */
export async function loadVnc(): Promise<VncClientClass> {
  return (await import('@novnc/novnc')).default as VncClientClass;
}
