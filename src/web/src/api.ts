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

/** SSE URL for a run's event stream (token in query, since EventSource has no headers). */
export const runEventsUrl = (runId: string, sinceSeq?: number): string => {
  const tok = encodeURIComponent(getToken() ?? '');
  const since = sinceSeq && sinceSeq > 0 ? `&sinceSeq=${sinceSeq}` : '';
  return `/api/runs/${runId}/events?access_token=${tok}${since}`;
};

// ── Interactive sessions (Route B) ──

/** Start a long-lived interactive session pinned to a runner (first message = prompt). */
export const createInteractiveSession = (body: {
  prompt: string;
  assignedRunnerId: string;
  agentId?: string;
  model?: string;
  permissionMode?: string;
}) =>
  api<{ id: string }>('/tasks', {
    method: 'POST',
    body: {
      ...body,
      interactive: true,
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
export const sendTurn = (taskId: string, content: string) =>
  api(`/tasks/${taskId}/turns`, {
    method: 'POST',
    body: { clientTurnId: uuid(), content },
  });

export const interruptSession = (taskId: string) =>
  api(`/tasks/${taskId}/interrupt`, { method: 'POST' });

export const endSession = (taskId: string) => api(`/tasks/${taskId}/end`, { method: 'POST' });
