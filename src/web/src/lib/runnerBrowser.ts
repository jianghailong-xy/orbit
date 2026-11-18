// The Orbit Cloud runner's browser, as the web reads it (docs/runner-browser-design.md §5; P3 = B shared input,
// P5 = web only). The server answers GET /runners/:id/browser with 404 while its browser switch is off, and for
// any runner that is not the caller's own managed one: both read here as "no browser", so nothing is drawn.

import { queryOptions } from '@tanstack/react-query';
import type { RunnerBrowserClearResponse, RunnerBrowserState } from '@orbit/shared';
import { api, ApiError, getToken } from '../api';

export const RUNNER_BROWSER_COPY = {
  chip: 'Browser',
  title: 'Browser',
  viewOnly: 'View only',
  takeControl: 'Take control',
  handBack: 'Hand back',
  done: 'Done',
  controllingFromSession: 'You are controlling the browser · the agent keeps running',
  controlling: 'You are controlling the browser',
  inputGoes: "Your pointer and keys go to the runner's browser",
  heldByThis: 'Used by this session',
  heldByNone: 'Not in use by any session',
  heldBy: (title: string) => `Used by “${title}” · it keeps running`,
  heldByUntitled: 'Used by another session · it keeps running',
  scaled: 'Scaled to fit',
  live: 'Live',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  section: 'Browser',
  rowTitle: 'Browser',
  idle: 'Idle · not running',
  running: 'Running',
  runningHeldBy: (title: string) => `Running · used by “${title}”`,
  runningInControl: 'Running · you are in control',
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
  });

/** `POST /runners/:id/browser/clear`: Clear saved logins, carried out at the runner's next heartbeat. */
export const clearRunnerBrowser = (runnerId: string) =>
  api<RunnerBrowserClearResponse>(`/runners/${runnerId}/browser/clear`, { method: 'POST' });

/** The viewer's WebSocket: the web login rides `access_token`, as a browser's WebSocket cannot set a header. */
export function runnerBrowserVncUrl(runnerId: string, origin: Location = window.location): string {
  const scheme = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${origin.host}/api/runners/${runnerId}/browser/vnc?access_token=${encodeURIComponent(getToken() ?? '')}`;
}

/** The part of noVNC's RFB this viewer uses (@novnc/novnc ships no types). */
export interface VncClient {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  /** The CSS background around the scaled picture. */
  background: string;
  addEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
  disconnect(): void;
  focus(): void;
}
export type VncClientClass = new (target: HTMLElement, url: string, options?: { shared?: boolean }) => VncClient;

/** noVNC, loaded only when a viewer opens: its module probes the browser's codecs at load. */
export async function loadVnc(): Promise<VncClientClass> {
  return (await import('@novnc/novnc')).default as VncClientClass;
}
