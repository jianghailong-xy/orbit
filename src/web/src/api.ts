import type { BgShell } from '@orbit/shared';

const TOKEN_KEY = 'orbit_token';
const REFRESH_KEY = 'orbit_refresh';

// Auto-refresh state (see the "Token auto-refresh" block below). Declared up here so the token
// accessors can reference the timer without a use-before-define.
let refreshInFlight: Promise<boolean> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const getRefreshToken = (): string | null => localStorage.getItem(REFRESH_KEY);

/** Persist a fresh login/refresh result (access + refresh) and (re)arm proactive refresh. */
export const setSession = (s: { accessToken: string; refreshToken: string }): void => {
  localStorage.setItem(TOKEN_KEY, s.accessToken);
  localStorage.setItem(REFRESH_KEY, s.refreshToken);
  scheduleProactiveRefresh();
};

/** Clear the whole session (access + refresh). Used on sign-out and on an unrecoverable 401. */
export const clearToken = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
};

// ── Token auto-refresh ──────────────────────────────────────────────────────────────────────
// The access token is short-lived; a long-lived, rotating refresh token (stored server-side) swaps
// for a fresh pair via POST /auth/refresh, so an active user is never bounced to /login. Refreshes
// are single-flighted (concurrent 401s share one call) and fire both reactively (on a 401, then the
// failed request retries once) and proactively (a timer ~1 min before the access token's `exp`). An
// already-open SSE stream was authed at connect time and keeps flowing; its next reconnect reads the
// refreshed token from localStorage, so no explicit stream re-auth is needed.

/** Swap the stored refresh token for a fresh access+refresh pair. Single-flight; resolves to whether
 *  a valid new access token is now stored. Never throws. */
export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false; // expired/revoked/reused → caller falls through to logout
    setSession((await res.json()) as { accessToken: string; refreshToken: string });
    return true;
  } catch {
    return false; // transient network error — keep the session; a later call retries
  }
}

/** Decode a JWT's `exp` (seconds since epoch), or null if it can't be read. The payload is
 *  base64url, so map `-_` back to `+/` before atob (which only accepts standard base64). */
function jwtExp(token: string): number | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(b64)) as { exp?: number };
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

/** (Re)arm a timer to refresh ~1 min before the current access token expires. Called on boot, after
 *  login, and after each refresh. Safe to call repeatedly (replaces any pending timer). */
export function scheduleProactiveRefresh(): void {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  const token = getToken();
  if (!token || !getRefreshToken()) return;
  const exp = jwtExp(token);
  if (exp == null) return;
  const ms = Math.max(0, exp * 1000 - Date.now() - 60_000);
  refreshTimer = setTimeout(() => {
    void refreshSession();
  }, ms);
}

/** Fetch with the bearer token attached; on a 401, try one single-flight refresh + retry, and on an
 *  unrecoverable 401 clear the session and bounce to /login. Every token-bearing call goes through
 *  here (the JSON `api()` helper, uploads, and the attachment/artifact blob fetches). */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const withAuth = (): RequestInit => ({
    ...init,
    headers: {
      ...init.headers,
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
  });
  let res = await fetch(input, withAuth());
  if (res.status === 401 && (await refreshSession())) {
    res = await fetch(input, withAuth()); // retry once with the refreshed token
  }
  if (res.status === 401) {
    clearToken();
    if (location.pathname !== '/login') location.href = '/login';
  }
  return res;
}

/** Revoke the stored refresh token server-side (best-effort) — called on explicit sign-out. */
export async function logoutSession(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return;
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // best-effort; clearing the local token still signs this browser out
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await authedFetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({ message: res.statusText }))) as {
      message?: string;
    };
    throw new Error(msg.message || res.statusText);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** SSE URL for a session's event stream (token in query, since EventSource has no headers). */
export const sessionEventsUrl = (sessionId: string, sinceSeq?: number): string => {
  const tok = encodeURIComponent(getToken() ?? '');
  const since = sinceSeq && sinceSeq > 0 ? `&sinceSeq=${sinceSeq}` : '';
  return `/api/sessions/${sessionId}/events?access_token=${tok}${since}`;
};

export interface EventPageEvent {
  seq: number;
  type: string;
  payload: any;
  turnId: string | null;
  ts: string;
}

/** A page of a session's persisted events, chronological (seq asc). `hasMore` = older
 *  events remain before this page. */
export interface EventPage {
  events: EventPageEvent[];
  hasMore: boolean;
}

/** Fetch a page of a session's history for tail-first lazy loading: `tail` gets the newest N
 *  (initial paint), `before`+`limit` get the N events just older than a seq (scroll-up). Lets a
 *  long transcript open at the latest message instead of replaying its whole history over SSE. */
export const getSessionEventPage = (
  id: string,
  opts: { tail?: number; before?: number; limit?: number },
): Promise<EventPage> => {
  const qs = new URLSearchParams();
  if (opts.tail != null) qs.set('tail', String(opts.tail));
  if (opts.before != null) qs.set('before', String(opts.before));
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  return api<EventPage>(`/sessions/${id}/events/page?${qs.toString()}`);
};

/** The authoritative, complete list of background shells the session ever launched (derived
 *  server-side over ALL persisted events, with output recovered from the agent's Read polls).
 *  The loaded event window only holds the most recent launches, so the tray merges this with
 *  its live-derived overlay — see mergeBackgroundShells. */
export const getBackgroundShells = (id: string): Promise<BgShell[]> =>
  api<BgShell[]>(`/sessions/${id}/background`);

// ── Interactive sessions (Route B) ──

/** Start a long-lived interactive session. Pick an agent (its machine + project dir
 *  is derived server-side) and/or pin a runner; the first message seeds the prompt. */
export const createInteractiveSession = (body: {
  prompt: string;
  assignedRunnerId?: string;
  agentId?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  /** Ids of images uploaded unscoped on the compose page; the server scopes them to the
   *  new session and links them to its seeded first turn. */
  attachmentIds?: string[];
  /** Compose from a `!cmd` draft: the server seeds the first turn as a shell command
   *  (run on the runner, bypassing claude) instead of a normal message. */
  shell?: boolean;
}) =>
  api<{ id: string }>('/sessions', {
    method: 'POST',
    body: {
      ...body,
      // Shell-launched sessions get a `$ …` title so they read as a command in the list. A
      // normal session sends NO title, so the server names it (DeepSeek summary + raw-prompt
      // fallback); sending the prompt as an explicit title here would suppress that naming.
      title: body.shell ? `$ ${body.prompt.trim()}`.slice(0, 80) : undefined,
    },
  });

/** UUIDv4 that also works outside a secure context (crypto.randomUUID needs https;
 *  the app is commonly served over plain http). crypto.getRandomValues is universal. */
const uuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Send the next user message to a live interactive session. While a turn is running
 *  the message is queued (delivered when the current turn finishes); the returned
 *  turnId identifies it, e.g. to withdraw it with cancelQueuedTurn. `attachmentIds` are
 *  ids of images already uploaded via uploadAttachment, sent alongside the text. */
export const sendTurn = (
  sessionId: string,
  content: string,
  attachmentIds?: string[],
  kind?: 'message' | 'shell',
) =>
  api<{ turnId: string; seq: number }>(`/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: {
      clientTurnId: uuid(),
      content,
      ...(attachmentIds?.length ? { attachmentIds } : {}),
      ...(kind === 'shell' ? { kind } : {}),
    },
  });

/** Upload one image to the control plane (multipart/form-data — the shared `api` helper
 *  only does JSON). With `sessionId` the blob is scoped to that session (live/resume turns);
 *  omitted (composing a new session) it's uploaded unscoped and the create call scopes it.
 *  Returns the new attachment id; reference it via createInteractiveSession/sendTurn/resume. */
export const uploadAttachment = async (file: File, sessionId?: string): Promise<{ id: string }> => {
  const form = new FormData();
  form.append('file', file);
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const res = await authedFetch(`/api/attachments${qs}`, {
    method: 'POST',
    // No content-type header: the browser sets the multipart boundary itself.
    body: form,
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({ message: res.statusText }))) as { message?: string };
    throw new Error(msg.message || res.statusText);
  }
  return (await res.json()) as { id: string };
};

/** Fetch an attachment's bytes as a blob object URL, for rendering a past turn's image in
 *  the transcript after reload. The download endpoint is bearer-guarded, so an `<img src>`
 *  pointing straight at it would 401 — fetch with the token, then hand back an object URL
 *  the caller must revoke. */
export const fetchAttachmentObjectUrl = async (id: string): Promise<string> => {
  const res = await authedFetch(`/api/attachments/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`attachment ${id}: ${res.status}`);
  return URL.createObjectURL(await res.blob());
};

export const fetchSessionArtifactObjectUrl = async (sessionId: string, artifactPath: string): Promise<string> => {
  const res = await authedFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/artifacts?path=${encodeURIComponent(artifactPath)}`,
  );
  if (!res.ok) throw new Error(`artifact ${artifactPath}: ${res.status}`);
  return URL.createObjectURL(await res.blob());
};

/** Fetch an attachment's bytes as a base64 data URL — used by the HTML export, where the
 *  bytes must be embedded inline (an object URL dies with the page, and the endpoint is
 *  bearer-guarded so a plain `<img src>` in the saved file would 401). */
export const fetchAttachmentDataUrl = async (id: string): Promise<string> => {
  const res = await authedFetch(`/api/attachments/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`attachment ${id}: ${res.status}`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
};

/** Withdraw a still-queued message (only works before the runner picks it up). */
export const cancelQueuedTurn = (sessionId: string, turnId: string) =>
  api(`/sessions/${sessionId}/turns/${turnId}`, { method: 'DELETE' });

/** Still-queued (PENDING) messages for a session — restores the visible queue when a
 *  running session is reopened/deep-linked (queued turns aren't in the event stream
 *  until the runner delivers them). */
export const listQueuedTurns = (sessionId: string) =>
  api<{ turnId: string; content: string; attachments?: { id: string; mimeType: string }[] }[]>(
    `/sessions/${sessionId}/turns`,
  );

/** Revive an ended session with a new message: the runner --resumes claude's
 *  existing context. Requires the session's runner to be online. `config` re-applies
 *  mode/model/effort changes made while ended (omitted fields keep the prior value).
 *  `kind: 'shell'` revives via a `!cmd` shell turn (run on the runner, output buffered
 *  for the next message) instead of a normal prompt — claude still --resumes and idles. */
export const resumeSession = (
  sessionId: string,
  content: string,
  config?: { model?: string; permissionMode?: string; effort?: string },
  attachmentIds?: string[],
  kind?: 'message' | 'shell',
) =>
  api<{ turnId: string; seq: number }>(`/sessions/${sessionId}/resume`, {
    method: 'POST',
    body: {
      clientTurnId: uuid(),
      content,
      ...config,
      ...(attachmentIds?.length ? { attachmentIds } : {}),
      ...(kind === 'shell' ? { kind } : {}),
    },
  });

export interface ApprovalInfo {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  toolUseId?: string;
  status: 'PENDING' | 'ALLOWED' | 'DENIED';
  message?: string;
  createdAt: string;
  decidedAt?: string;
}

/** Pending (default) tool-permission approvals awaiting a human allow/deny. */
export const listApprovals = (sessionId: string, status = 'PENDING') =>
  api<ApprovalInfo[]>(`/sessions/${sessionId}/approvals?status=${status}`);

/** A claude permission rule to add for the rest of the session so future "same kind"
 *  calls are auto-allowed (mirrors PermissionRule in @orbit/shared). */
export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
}

/** Allow or deny a pending tool-permission approval; the runner's long-poll
 *  delivers the decision back to claude's --permission-prompt-tool. For an
 *  AskUserQuestion, `answers` (question text → picked labels) rides along an allow.
 *  `rememberRules` (on an allow) auto-allows the same kinds of call for the session. */
export const decideApproval = (
  sessionId: string,
  approvalId: string,
  behavior: 'allow' | 'deny',
  message?: string,
  answers?: Record<string, string[]>,
  rememberRules?: PermissionRule[],
) =>
  api<ApprovalInfo>(`/sessions/${sessionId}/approvals/${approvalId}/decision`, {
    method: 'POST',
    body: { behavior, message, answers, rememberRules },
  });

/** Change a live session's model, permission mode and/or effort between turns. The
 *  runner re-spawns claude with --resume so the change takes effect on the next turn. */
export const updateSessionConfig = (
  sessionId: string,
  config: { model?: string; permissionMode?: string; effort?: string },
) => api(`/sessions/${sessionId}/config`, { method: 'PATCH', body: config });

/** Rename a session's display title. Works on any session (live or ended) and never
 *  touches the runner — purely a metadata update. */
export const renameSession = (sessionId: string, title: string) =>
  api(`/sessions/${sessionId}`, { method: 'PATCH', body: { title } });

export const interruptSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/interrupt`, { method: 'POST' });

export const endSession = (sessionId: string) => api(`/sessions/${sessionId}/end`, { method: 'POST' });

/** Ask the runner that ran this session to merge its worktree branch into `targetBranch`
 *  (omitted → the default: the runner auto-detects main, else master). Async: the outcome
 *  lands on SessionDetail.mergeStatus within a heartbeat (~30s). */
export const mergeSessionToMain = (sessionId: string, targetBranch?: string) =>
  api(`/sessions/${sessionId}/merge`, {
    method: 'POST',
    body: targetBranch ? { targetBranch } : {},
  });

/** Ask the runner to commit a live session's uncommitted worktree changes onto its branch.
 *  Async: the outcome lands on SessionDetail.commitStatus / worktreeDirty within a heartbeat. */
export const commitSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/commit`, { method: 'POST' });

// Soft visibility actions for ended sessions. Archive hides a session into the
// Archived view; delete moves it to the trash. Both keep all data; restore (which
// clears both) brings it back to the active list. Purge is the only hard delete: it
// permanently removes a trashed session and all its data, irreversibly.
export const archiveSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/archive`, { method: 'POST' });

export const deleteSession = (sessionId: string) =>
  api(`/sessions/${sessionId}`, { method: 'DELETE' });

export const restoreSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/restore`, { method: 'POST' });

/** Permanently delete a trashed session and all its data (irreversible; no restore). */
export const purgeSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/purge`, { method: 'DELETE' });

// Pin/unpin a session to the top of the session list (personal ordering; ordering only).
export const pinSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/pin`, { method: 'POST' });

export const unpinSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/pin`, { method: 'DELETE' });

// ── Public read-only sharing ──
// Enable sharing mints (or returns) an unguessable token; the public link is `/s/<token>`.
// Disable revokes it (the old link 404s). The current token also rides on SessionDetail.shareToken.
export const enableSessionShare = (sessionId: string) =>
  api<{ shareToken: string; sharedAt: string }>(`/sessions/${sessionId}/share`, { method: 'POST' });

export const disableSessionShare = (sessionId: string) =>
  api(`/sessions/${sessionId}/share`, { method: 'DELETE' });

/** One event in a public shared transcript (mirrors the owner SSE payload, sans live state). */
export interface SharedEvent {
  seq: number;
  type: string;
  payload: any;
  turnId: string | null;
  ts: string;
}

/** A session's sanitized, read-only transcript as served to a public share-link viewer. */
export interface SharedSession {
  title: string;
  agentName: string | null;
  status: string;
  createdAt: string;
  events: SharedEvent[];
}

/** Fetch a shared session by its public token. No auth — the token is the capability; a
 *  revoked/unknown token 404s. Bypasses the bearer `api()` helper so a logged-out viewer
 *  isn't bounced to /login. */
export const getSharedSession = async (token: string): Promise<SharedSession> => {
  const res = await fetch(`/api/shared/${encodeURIComponent(token)}`);
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({ message: res.statusText }))) as { message?: string };
    throw new Error(msg.message || res.statusText);
  }
  return (await res.json()) as SharedSession;
};

/** Object URL for an inline image in a shared transcript, via the public attachment route
 *  (no bearer). Caller revokes it. Mirrors fetchAttachmentObjectUrl for the shared page. */
export const fetchSharedAttachmentObjectUrl = async (token: string, id: string): Promise<string> => {
  const res = await fetch(
    `/api/shared/${encodeURIComponent(token)}/attachments/${encodeURIComponent(id)}`,
  );
  if (!res.ok) throw new Error(`attachment ${id}: ${res.status}`);
  return URL.createObjectURL(await res.blob());
};

export const fetchSharedArtifactObjectUrl = async (token: string, artifactPath: string): Promise<string> => {
  const res = await fetch(
    `/api/shared/${encodeURIComponent(token)}/artifacts?path=${encodeURIComponent(artifactPath)}`,
  );
  if (!res.ok) throw new Error(`artifact ${artifactPath}: ${res.status}`);
  return URL.createObjectURL(await res.blob());
};

/** Base64 data URL for an inline image in a shared transcript, via the public attachment
 *  route (no bearer). The shared-page HTML download embeds the bytes inline so the saved
 *  file works offline. Mirrors fetchAttachmentDataUrl, but for a logged-out viewer. */
export const fetchSharedAttachmentDataUrl = async (token: string, id: string): Promise<string> => {
  const res = await fetch(
    `/api/shared/${encodeURIComponent(token)}/attachments/${encodeURIComponent(id)}`,
  );
  if (!res.ok) throw new Error(`attachment ${id}: ${res.status}`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
};

/** One file a worktree-isolated session changed (git diff baseSha..branch); additions/
 *  deletions are -1 for binary files. Mirrors @orbit/shared ChangedFile. */
export interface SessionChangedFile {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

/** A single session's detail, as returned by GET /sessions/:id. Only the fields the web
 *  reads are typed; `branch`/`baseSha`/`changedFiles`/`isolationStatus` carry the
 *  per-session git worktree result (null until the runner reports completion). */
export interface SessionDetail {
  id: string;
  status?: string;
  title?: string;
  createdAt?: string;
  lastTurnAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  endReason?: string | null;
  source?: string | null;
  assignedRunnerId: string | null;
  provider?: string | null;
  // `defaultMergeTarget` is the branch this agent's sessions merge into by default,
  // remembered from the last target the user switched to in the merge dropdown (null = the
  // runner's auto-detected default). Agent-scoped, so it sticks across the agent's sessions.
  agent: { id: string; provider?: string | null; defaultMergeTarget?: string | null } | null;
  branch?: string | null;
  baseSha?: string | null;
  changedFiles?: SessionChangedFile[] | null;
  isolationStatus?: string | null;
  // "Merge to main" outcome (see mergeSessionToMain): 'pending' while the runner works,
  // then 'merged' (mergedAt set) | 'conflict' | 'error' (mergeError carries why). Null
  // until the user clicks merge.
  mergeStatus?: 'pending' | 'merged' | 'conflict' | 'error' | null;
  mergeError?: string | null;
  mergedAt?: string | null;
  // The branch the user chose to merge into (status bar's branch dropdown). Null = the
  // default (runner auto-detects main, else master). Shown on the merged ✓ chip + used by
  // "Retry merge" to retry the same target.
  mergeTarget?: string | null;
  // Candidate merge-target branches the runner reported for this session's repo (local
  // branches minus orbit/*), populating the dropdown. Empty for older runners → no dropdown.
  mergeTargets?: string[] | null;
  // Whether the branch already landed in the default target (main, else master) — the runner's
  // `git merge-base --is-ancestor` result. True → the bar shows a "✓ In main" chip instead of a
  // redundant Merge button (the work merged out-of-band, e.g. a command-line push). Null = not
  // reported (older runner / not recomputed since) → the bar keeps its mergeStatus behavior.
  branchMerged?: boolean | null;
  // Live-worktree commit state (see commitSession). worktreeDirty drives the bar's primary
  // action — true → Commit, false → Merge — when the runner reports it (null = not reported,
  // so the bar falls back to the session lifecycle). commitStatus is 'pending' while the
  // runner commits, then 'committed' | 'nochange' | 'error' (commitError carries why).
  worktreeDirty?: boolean | null;
  commitStatus?: 'pending' | 'committed' | 'nochange' | 'error' | null;
  commitError?: string | null;
  // Public read-only sharing: the unguessable token behind the `/s/<token>` link, or null when
  // not shared. Set/cleared by enable/disableSessionShare; drives the Share dialog's state.
  shareToken?: string | null;
  sharedAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  runningBgShells?: string[] | null;
}

/** Fetch one session by id (accepts a base62 public id or a raw UUID). Used to
 *  resolve the runner behind a `/sessions/:id` deep link and show its worktree output. */
export const getSession = (idOrPublicId: string) =>
  api<SessionDetail>(`/sessions/${idOrPublicId}`);

/** One changed file's full unified-diff text (git diff vs base). `patch` is absent for a
 *  binary file (shown via the stat instead) or one dropped for size; `truncated` marks the
 *  latter. Mirrors @orbit/shared FilePatch. Fetched lazily, only when a file's diff opens. */
export interface SessionFilePatch {
  path: string;
  patch?: string;
  truncated?: boolean;
}

/** The session's per-file diffs, kept off the session payload and fetched on demand when a
 *  file in the worktree status bar is opened (GET /sessions/:id/diff). */
export const getSessionDiff = (idOrPublicId: string) =>
  api<{ patches: SessionFilePatch[] }>(`/sessions/${idOrPublicId}/diff`);

/** Ask the live runner to recompute the worktree diff now (fixes a file listed but with no
 *  stored patch — "No diff to preview" — when the snapshot lagged the live worktree). The fresh
 *  diff lands asynchronously via the runner, so the caller refetches getSessionDiff after. */
export const refreshSessionDiff = (idOrPublicId: string) =>
  api<void>(`/sessions/${idOrPublicId}/diff/refresh`, { method: 'POST' });

/** Enable per-session worktree isolation for an agent whose workDir isn't a git repo:
 *  flips `autoInitGit` so the runner `git init`s the dir (default .gitignore + baseline
 *  commit) on the agent's next run, after which sessions isolate on their own branch. */
export const enableAgentIsolation = (agentId: string) =>
  api(`/agents/${agentId}`, { method: 'PATCH', body: { autoInitGit: true } });
