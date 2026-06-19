const TOKEN_KEY = 'orbit_token';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
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

/** Send the next user message to a live interactive session. */
export const sendTurn = (sessionId: string, content: string) =>
  api(`/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: { clientTurnId: uuid(), content },
  });

/** Revive an ended session with a new message: the runner --resumes claude's
 *  existing context. Requires the session's runner to be online. `config` re-applies
 *  mode/model/effort changes made while ended (omitted fields keep the prior value). */
export const resumeSession = (
  sessionId: string,
  content: string,
  config?: { model?: string; permissionMode?: string; effort?: string },
) =>
  api(`/sessions/${sessionId}/resume`, {
    method: 'POST',
    body: { clientTurnId: uuid(), content, ...config },
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

/** Allow or deny a pending tool-permission approval; the runner's long-poll
 *  delivers the decision back to claude's --permission-prompt-tool. */
export const decideApproval = (
  sessionId: string,
  approvalId: string,
  behavior: 'allow' | 'deny',
  message?: string,
) =>
  api<ApprovalInfo>(`/sessions/${sessionId}/approvals/${approvalId}/decision`, {
    method: 'POST',
    body: { behavior, message },
  });

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

/** Fetch one session by id (accepts a base62 public id or a raw UUID). Used to
 *  resolve the runner behind a `/sessions/:id` deep link. */
export const getSession = (idOrPublicId: string) =>
  api<{ id: string; assignedRunnerId: string | null; agent: { id: string } | null }>(
    `/sessions/${idOrPublicId}`,
  );
