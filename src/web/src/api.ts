const TOKEN_KEY = 'orbit_token';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    if (location.pathname !== '/login') location.href = '/login';
  }
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
}) =>
  api<{ id: string }>('/sessions', {
    method: 'POST',
    body: {
      ...body,
      title: body.prompt.trim().slice(0, 80) || 'Interactive session',
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
  const res = await fetch(`/api/attachments${qs}`, {
    method: 'POST',
    // No content-type header: the browser sets the multipart boundary itself.
    headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {},
    body: form,
  });
  if (res.status === 401) {
    clearToken();
    if (location.pathname !== '/login') location.href = '/login';
  }
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
  const res = await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
    headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {},
  });
  if (!res.ok) throw new Error(`attachment ${id}: ${res.status}`);
  return URL.createObjectURL(await res.blob());
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
 *  mode/model/effort changes made while ended (omitted fields keep the prior value). */
export const resumeSession = (
  sessionId: string,
  content: string,
  config?: { model?: string; permissionMode?: string; effort?: string },
  attachmentIds?: string[],
) =>
  api<{ turnId: string; seq: number }>(`/sessions/${sessionId}/resume`, {
    method: 'POST',
    body: { clientTurnId: uuid(), content, ...config, ...(attachmentIds?.length ? { attachmentIds } : {}) },
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
 *  `rememberRule` (on an allow) auto-allows the same kind of call for the session. */
export const decideApproval = (
  sessionId: string,
  approvalId: string,
  behavior: 'allow' | 'deny',
  message?: string,
  answers?: Record<string, string[]>,
  rememberRule?: PermissionRule,
) =>
  api<ApprovalInfo>(`/sessions/${sessionId}/approvals/${approvalId}/decision`, {
    method: 'POST',
    body: { behavior, message, answers, rememberRule },
  });

/** Change a live session's model, permission mode and/or effort between turns. The
 *  runner re-spawns claude with --resume so the change takes effect on the next turn. */
export const updateSessionConfig = (
  sessionId: string,
  config: { model?: string; permissionMode?: string; effort?: string },
) => api(`/sessions/${sessionId}/config`, { method: 'PATCH', body: config });

export const interruptSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/interrupt`, { method: 'POST' });

export const endSession = (sessionId: string) => api(`/sessions/${sessionId}/end`, { method: 'POST' });

// Soft visibility actions for ended sessions. Archive hides a session into the
// Archived view; delete moves it to the trash. Both keep all data; restore (which
// clears both) brings it back to the active list. There is no hard delete.
export const archiveSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/archive`, { method: 'POST' });

export const deleteSession = (sessionId: string) =>
  api(`/sessions/${sessionId}`, { method: 'DELETE' });

export const restoreSession = (sessionId: string) =>
  api(`/sessions/${sessionId}/restore`, { method: 'POST' });

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
  assignedRunnerId: string | null;
  agent: { id: string } | null;
  branch?: string | null;
  baseSha?: string | null;
  changedFiles?: SessionChangedFile[] | null;
  isolationStatus?: string | null;
}

/** Fetch one session by id (accepts a base62 public id or a raw UUID). Used to
 *  resolve the runner behind a `/sessions/:id` deep link and show its worktree output. */
export const getSession = (idOrPublicId: string) =>
  api<SessionDetail>(`/sessions/${idOrPublicId}`);

/** Enable per-session worktree isolation for an agent whose workDir isn't a git repo:
 *  flips `autoInitGit` so the runner `git init`s the dir (default .gitignore + baseline
 *  commit) on the agent's next run, after which sessions isolate on their own branch. */
export const enableAgentIsolation = (agentId: string) =>
  api(`/agents/${agentId}`, { method: 'PATCH', body: { autoInitGit: true } });
