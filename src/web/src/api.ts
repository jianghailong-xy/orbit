import type {
  BgShell,
  ConversationTurnKind,
  SessionCapabilities,
  SessionTurnIntent,
  SessionTurnPlacement,
} from '@orbit/shared';
import { clearTranscriptStore, setTranscriptUser } from './lib/transcriptStore';
import { compatibleUuid as uuid } from './lib/uuid';

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
  // Scope the persistent transcript cache to whoever this token belongs to. Done here rather than
  // from the `me` query so it is bound before the first read: the token itself names the user, so
  // no round trip is needed, and no window exists where a cache read is unscoped.
  setTranscriptUser(jwtSubject(s.accessToken));
};

/** Clear the whole session (access + refresh). Used on sign-out and on an unrecoverable 401. */
export const clearToken = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
  // Signing out has to take the stored transcripts with it — otherwise the full text of every
  // conversation stays readable on disk to the next person to use this browser.
  clearTranscriptStore();
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

/** Decode a JWT's `sub` (the user id), or null if it can't be read. Same base64url handling as
 *  jwtExp above. Only used to scope local caches — the server re-verifies the token regardless,
 *  so reading it unverified here grants nothing. */
function jwtSubject(token: string): string | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { sub } = JSON.parse(atob(b64)) as { sub?: string };
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

/** (Re)arm a timer to refresh ~1 min before the current access token expires. Called on boot, after
 *  login, and after each refresh. Safe to call repeatedly (replaces any pending timer).
 *
 *  Also the boot-time hook that binds the persistent transcript cache to the stored session: this
 *  runs from main.tsx before the first render, so a reload has its user scope set before WorkspaceView
 *  reads anything. */
export function scheduleProactiveRefresh(): void {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  const token = getToken();
  setTranscriptUser(token ? jwtSubject(token) : null);
  if (!token || !getRefreshToken()) return;
  const exp = jwtExp(token);
  if (exp == null) return;
  const ms = Math.max(0, exp * 1000 - Date.now() - 60_000);
  refreshTimer = setTimeout(() => {
    void refreshSession();
  }, ms);
}

// Baked in at build time from the repo version (see vite.config.ts). Sent on every request so the
// server can answer "is anything still in the field older than X?" before a wire format changes —
// a browser tab left open for a month is exactly the client nothing else can see.
declare const __APP_VERSION__: string;

/** Fetch with the bearer token attached; on a 401, try one single-flight refresh + retry, and on an
 *  unrecoverable 401 clear the session and bounce to /login. Every token-bearing call goes through
 *  here (the JSON `api()` helper, uploads, and the attachment/artifact blob fetches). */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const withAuth = (): RequestInit => ({
    ...init,
    headers: {
      ...init.headers,
      'x-orbit-client': `web/${__APP_VERSION__}`,
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
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** Cancels the request (and its 401 retry). Callers that fire a read on every selection
     *  change pass one so a superseded request stops occupying a connection. */
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const res = await authedFetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({ message: res.statusText }))) as Record<
      string,
      unknown
    >;
    let message = res.statusText;
    if (typeof msg.message === 'string') message = msg.message;
    else if (Array.isArray(msg.message) && msg.message.every((item) => typeof item === 'string')) {
      message = msg.message.join('; ');
    }
    throw new ApiError(
      message,
      res.status,
      typeof msg.code === 'string' ? msg.code : undefined,
      msg,
    );
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** HTTP-aware error used only where a rolling-upgrade compatibility fallback is safe. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /**
     * The server's own machine code for this refusal, when the body carried one (a NestJS
     * exception thrown with an object body). Kept beside the prose because one status can mean
     * several different things — `STALE_CONFIG_REVISION`, `PROJECT_SETTLED` and
     * `COORDINATOR_DISABLED` are all 409 — and only one of them may ever be retried automatically.
     * Branching on the message instead would break the first time somebody reworded it.
     */
    public readonly code?: string,
    /**
     * The complete structured body. Advisory responses carry suggestedCriterion, reason and the
     * override field here; keeping only `message` would turn a question into an opaque error the
     * web form cannot answer. Ordinary callers may ignore it.
     */
    public readonly body?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Longest string the server keeps inside a tool call/result before clipping it to a preview and
 *  marking the event `truncated`. A folded tool card shows ~12 lines, so ~2KB is already more than
 *  it can display; the untouched payload is refetched per card from getSessionEventFull when the
 *  user expands it. Sent on both the page fetch and the SSE so a card looks the same either way. */
export const MAX_EVENT_PAYLOAD = 2048;

/** SSE URL for a session's event stream (token in query, since EventSource has no headers). */
export const sessionEventsUrl = (sessionId: string, sinceSeq?: number): string => {
  const tok = encodeURIComponent(getToken() ?? '');
  const since = sinceSeq && sinceSeq > 0 ? `&sinceSeq=${sinceSeq}` : '';
  return `/api/sessions/${sessionId}/events?access_token=${tok}${since}&maxPayload=${MAX_EVENT_PAYLOAD}`;
};

export interface EventPageEvent {
  seq: number;
  type: string;
  payload: any;
  turnId: string | null;
  ts: string;
  /** The server clipped this event's tool body to a preview — expand the card to refetch it whole. */
  truncated?: boolean;
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
  opts: { tail?: number; before?: number; limit?: number; signal?: AbortSignal },
): Promise<EventPage> => {
  const qs = new URLSearchParams();
  if (opts.tail != null) qs.set('tail', String(opts.tail));
  if (opts.before != null) qs.set('before', String(opts.before));
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  qs.set('maxPayload', String(MAX_EVENT_PAYLOAD));
  return api<EventPage>(`/sessions/${id}/events/page?${qs.toString()}`, { signal: opts.signal });
};

/** The untrimmed payload of one event, fetched when the user expands a card that arrived
 *  `truncated` — so a big Read/Write body costs a request only if someone actually opens it. */
export const getSessionEventFull = (id: string, seq: number): Promise<EventPageEvent> =>
  api<EventPageEvent>(`/sessions/${id}/events/${seq}/full`);

/** The authoritative, complete list of background shells the session ever launched (derived
 *  server-side over ALL persisted events, with output recovered from the workspace's Read polls).
 *  The loaded event window only holds the most recent launches, so the tray merges this with
 *  its live-derived overlay — see mergeBackgroundShells. */
export const getBackgroundShells = (id: string): Promise<BgShell[]> =>
  api<BgShell[]>(`/sessions/${id}/background`);

// ── Interactive sessions (Route B) ──

/** Start a long-lived interactive session. Pick a workspace (its machine + project dir
 *  is derived server-side) and/or pin a runner; the first message seeds the prompt. */
export const createInteractiveSession = (body: {
  prompt: string;
  assignedRunnerId?: string;
  workspaceId?: string;
  /** Provider picked on the New Session screen: a built-in engine slug or one of the caller's
   *  configured providers. Omitted inherits the workspace's, which is the historical behaviour. */
  provider?: string;
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
      // normal session sends NO title, so the server immediately uses a prompt-derived fallback
      // and may improve it asynchronously; an explicit title would suppress that naming.
      title: body.shell ? `$ ${body.prompt.trim()}`.slice(0, 80) : undefined,
    },
  });

/** Send the next user message to a live interactive session. The returned turnId identifies
 *  it, e.g. to withdraw it with cancelQueuedTurn. `attachmentIds` are ids of images already
 *  uploaded via uploadAttachment, sent alongside the text.
 *
 *  The response's `kind` is what the server filed it as, which is not what was asked for: a
 *  message sent while a turn is running becomes a `steer` — written into that turn instead of
 *  queued behind it — and a steer is neither withdrawable nor waiting. See lib/steerDelivery.
 *  `placement` is the server's row-locked answer to whether this specific turn was accepted as
 *  the next executable, queued behind an earlier one, or steered into the running one. New Web is deployed only after every API replica supports this required receipt;
 *  silently guessing across version skew would reintroduce the race. */
export const sendTurn = (
  sessionId: string,
  content: string,
  attachmentIds?: string[],
  kind?: 'message' | 'shell',
  intent: SessionTurnIntent = 'NEXT_TURN',
  clientTurnId: string = uuid(),
) =>
  api<{
    turnId: string;
    seq: number;
    kind: ConversationTurnKind;
    placement: SessionTurnPlacement;
    targetTurnId?: string;
  }>(`/sessions/${sessionId}/turns/current-work-routing`, {
    method: 'POST',
    body: {
      clientTurnId,
      content,
      intent,
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

export interface ActiveSessionTurn {
  turnId: string;
  kind: ConversationTurnKind;
  placement: SessionTurnPlacement;
  content: string;
  createdAt: string;
  targetTurnId?: string;
  delivery?: 'failed' | 'unconfirmed';
  deliveryCode?: string;
  deliveryReason?: string;
  attachments?: { id: string; mimeType: string }[];
}

/** Opt into active PENDING/IN_FLIGHT turns not represented by the transcript yet — restores
 *  bubbles on reopen and bridges the dequeue-to-first-event gap. The unqualified endpoint keeps
 *  its PENDING-only response for older native clients. Placement distinguishes the accepted head,
 *  queued successors and steers. Placement is the server-owned fact. */
export const listQueuedTurns = (sessionId: string) =>
  api<ActiveSessionTurn[]>(`/sessions/${sessionId}/turns?view=active`);

/** Revive an ended session with a new message: the runner --resumes claude's
 *  existing context. Requires the session's runner to be online. `config` re-applies
 *  mode/model/effort changes made while ended (omitted fields keep the prior value).
 *  `kind: 'shell'` revives via a `!cmd` shell turn (run on the runner, output buffered
 *  for the next message) instead of a normal prompt — claude still --resumes and idles.
 *  A true terminal revive is accepted; if the session became live before the request landed,
 *  kind/placement carry sendTurn's required row-locked decision. */
export const resumeSession = (
  sessionId: string,
  content: string,
  config?: { model?: string; permissionMode?: string; effort?: string; provider?: string },
  attachmentIds?: string[],
  kind?: 'message' | 'shell',
  clientTurnId: string = uuid(),
) =>
  api<{
    turnId: string;
    seq: number;
    kind: ConversationTurnKind;
    placement: SessionTurnPlacement;
  }>(`/sessions/${sessionId}/resume`, {
    method: 'POST',
    body: {
      clientTurnId,
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

/** A claude permission rule so future "same kind" calls are auto-allowed
 *  (mirrors PermissionRule in @orbit/shared). */
export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
}

/** A standing "always allow" grant on a workspace — one of these rules, kept, so every
 *  session of that workspace starts with it instead of asking again. */
export interface WorkspacePermissionRuleInfo {
  id: string;
  toolName: string;
  /** '' = every call to that tool. */
  ruleContent: string;
  createdAt: string;
}

/** Revoke a standing grant. The workspace's sessions ask about that call again from their
 *  next dispatch on; a session already running keeps what its runtime was started with. */
export const revokeWorkspacePermissionRule = (workspaceId: string, ruleId: string) =>
  api(`/workspaces/${workspaceId}/permission-rules/${ruleId}`, { method: 'DELETE' });

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

/** Change a live session's model, permission mode, effort and/or provider — mid-turn included.
 *  Model, permission mode and effort are handed to the running engine over its control channel and
 *  take effect where the turn stands; a provider is spawn-only (it IS the process's environment),
 *  so the runner re-spawns with --resume once the turn ends and it takes effect on the next one
 *  (`configPillHints` is the copy that says which is which, and only the claude runtime has the
 *  control channel). */
export const updateSessionConfig = (
  sessionId: string,
  config: { model?: string; permissionMode?: string; effort?: string; provider?: string },
) => api(`/sessions/${sessionId}/config`, { method: 'PATCH', body: config });

/** Rename a session's display title. Works on any session (live or ended) and never
 *  touches the runner — purely a metadata update. */
export const renameSession = (sessionId: string, title: string) =>
  api(`/sessions/${sessionId}`, { method: 'PATCH', body: { title } });

/**
 * Stop the turn the session is running. With `followUp`, what to do instead is queued in
 * the SAME request — one transaction server-side, not a stop followed by a send.
 *
 * The two cannot be two requests: interrupting drops the follow-ups queued behind the
 * running turn, so a send that arrives just before the interrupt is deleted by it, and one
 * that arrives just after is filed as a steer — written into the very turn being stopped.
 * Which of those happened would come down to network ordering. Sent together, the message
 * is filed after the drop and delivered as the next turn.
 */
export const interruptSession = (
  sessionId: string,
  followUp?: { content: string; attachmentIds?: string[] },
) =>
  api<{ ok: true; turnId?: string; seq?: number }>(`/sessions/${sessionId}/interrupt`, {
    method: 'POST',
    ...(followUp
      ? {
          body: {
            clientTurnId: uuid(),
            content: followUp.content,
            ...(followUp.attachmentIds?.length ? { attachmentIds: followUp.attachmentIds } : {}),
          },
        }
      : {}),
  });

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

/** Adopt the worktree's actual HEAD branch (after an in-worktree `git checkout -b`) as the
 *  session's tracked branch, so Merge/diff act on the real work instead of a stale "In main".
 *  Pure server-side re-point; the change reflects on the next detail fetch. */
export const adoptSessionBranch = (sessionId: string) =>
  api<{ ok: true; branch: string }>(`/sessions/${sessionId}/adopt-branch`, { method: 'POST' });

// Lifecycle actions for sessions. Complete moves a session into Completed; delete
// moves it to Trash. Both keep all data; restore brings either back to Open. Purge is
// the only hard delete: it permanently removes a trashed session and all its data.
export const completeSession = async (sessionId: string) => {
  try {
    return await api(`/sessions/${sessionId}/complete`, { method: 'POST' });
  } catch (error) {
    // A new browser bundle may briefly overlap an older API replica. Fall back only when
    // the canonical route is absent; authorization/conflict/server errors must not replay.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return api(`/sessions/${sessionId}/archive`, { method: 'POST' });
  }
};

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

// Turn off / put back the retry armed on this session by a spent quota or a transient provider
// error. Arming is automatic when one of those kills a turn; `armAutoRetry` exists so the card's
// switch can be flipped both ways, and carries the instant because the server dropped its copy
// when the retry was cancelled (the caller re-derives it with `parseQuotaResetAt`).
export const cancelAutoRetry = (sessionId: string) =>
  api(`/sessions/${sessionId}/auto-retry`, { method: 'DELETE' });

export const armAutoRetry = (sessionId: string, retryAt: Date) =>
  api<{ retryAt: string }>(`/sessions/${sessionId}/auto-retry`, {
    method: 'POST',
    body: { retryAt: retryAt.toISOString() },
  });

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
  workspaceName: string | null;
  runState?: string;
  lifecycleState?: string;
  /** Legacy API name retained during rolling upgrades. */
  filingState?: string;
  sessionState?: string;
  runStatus?: string;
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

/** Compact row returned by GET /sessions. The API evolves independently of this console, so the
 * existing row fields remain open. */
export type SessionListItem = Record<string, any> & {
  id: string;
  runState?: string | null;
  lifecycleState?: string | null;
  filingState?: string | null;
  sessionState?: string | null;
  runStatus?: string | null;
  status?: string | null;
};

/** A single session's detail, as returned by GET /sessions/:id. Only the fields the web
 *  reads are typed; `branch`/`baseSha`/`changedFiles`/`isolationStatus` carry the
 *  per-session git worktree result (null until the runner reports completion). */
export interface SessionDetail {
  id: string;
  /** Latest run outcome and sidebar lifecycle location are independent product dimensions. */
  runState?: string;
  lifecycleState?: string;
  /** Legacy API name retained during rolling upgrades. */
  filingState?: string;
  capabilities?: SessionCapabilities;
  /** Legacy mixed product lifecycle retained during migration. */
  sessionState?: string;
  /** Explicit runner/process state. `status` is its legacy alias. */
  runStatus?: string;
  status?: string;
  title?: string;
  /** The Project this Session coordinates. Null for ordinary Sessions. */
  projectId?: string | null;
  projectTitle?: string | null;
  prompt?: string | null;
  createdAt?: string;
  lastTurnAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  endReason?: string | null;
  source?: string | null;
  assignedRunnerId: string | null;
  provider?: string | null;
  // When the armed auto-retry fires (null = nothing armed), and how many attempts this run of
  // failures has already spent. Drives the transcript's quota / provider-error card.
  retryAt?: string | null;
  retryAttempts?: number;
  // `defaultMergeTarget` is the branch this workspace's sessions merge into by default,
  // remembered from the last target the user switched to in the merge dropdown (null = the
  // runner's auto-detected default). Workspace-scoped, so it sticks across the workspace's sessions.
  // No `permissionMode` here on purpose: the posture belongs to the run, defaulted from the
  // account (UserPreferences.defaultPermissionMode).
  workspace: {
    id: string;
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    defaultMergeTarget?: string | null;
  } | null;
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
  // The worktree's ACTUAL current HEAD branch, as last reported by the runner. Normally equals
  // `branch`; it differs when the workspace ran `git checkout -b` inside the worktree, moving the work
  // onto a branch Orbit isn't tracking. When it differs, the bar flags the divergence ("On <branch>
  // — not tracked") instead of a stale "✓ In main" and offers Adopt (re-points `branch` here).
  worktreeBranch?: string | null;
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
  completedAt?: string | null;
  /** Legacy API timestamp retained during rolling upgrades. */
  archivedAt?: string | null;
  deletedAt?: string | null;
  runningBgShells?: string[] | null;
}

/** Fetch one session by id (accepts a base62 public id or a raw UUID). Used to
 *  resolve the runner behind a `/sessions/:id` deep link and show its worktree output. */
export const getSession = (idOrPublicId: string) =>
  api<SessionDetail>(`/sessions/${idOrPublicId}`);

/**
 * Open (or return) the conversation a task list is steered from.
 *
 * `created` distinguishes the two: the caller can drop the user straight into an existing
 * conversation, or say "opened a new one" when there wasn't one to return to. Calling it twice
 * yields the same session rather than a second one.
 */
export const openTaskListConsole = (idOrPublicId: string, workspaceId?: string) =>
  api<{ sessionId: string; created: boolean }>(`/task-lists/${idOrPublicId}/console`, {
    method: 'POST',
    body: workspaceId ? { workspaceId } : {},
  });

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

/** Enable per-session worktree isolation for a workspace whose workDir isn't a git repo:
 *  flips `autoInitGit` so the runner `git init`s the dir (default .gitignore + baseline
 *  commit) on the workspace's next run, after which sessions isolate on their own branch. */
export const enableWorkspaceIsolation = (workspaceId: string) =>
  api(`/workspaces/${workspaceId}`, { method: 'PATCH', body: { autoInitGit: true } });

/** Ask this workspace's runner to clean up the shared checkout it works in: the runner saves whatever
 *  the checkout is holding onto an `orbit/rescue-*` branch, then returns it to HEAD. Queued for
 *  the runner's next heartbeat; the outcome arrives on the workspace's `repoCleanup`. */
export const cleanUpWorkspaceRepo = (workspaceId: string) =>
  api<{ repoCleanup?: { status: string; branch?: string | null; message?: string | null } | null }>(
    `/workspaces/${workspaceId}/repo-cleanup`,
    { method: 'POST' },
  );
