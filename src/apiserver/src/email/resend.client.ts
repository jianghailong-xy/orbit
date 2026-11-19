/**
 * Sending one email through Resend's HTTP API (docs/welcome-email-design.md §3.2, decision D1): Node's
 * own `fetch`, no SDK, a 10-second timeout, and an answer classified for the outbox worker.
 *
 * Idempotency (checked against resend.com/docs/dashboard/emails/idempotency-keys, 2026-11-11): a key is
 * kept for 24 hours, far past the outbox's longest retry span (~71 minutes); the same key with the same
 * payload answers the first result without sending again; with another payload it is `409
 * invalid_idempotent_request`; a request while one with the same key is in flight is `409
 * concurrent_idempotent_requests`. The docs do not say whether an error answer is cached under its key,
 * so the outbox assumes it may be: after an ANSWERED failure the next attempt uses a new key (nothing was
 * sent, so nothing can be duplicated), and only an attempt that got no answer (timeout, network error) is
 * retried under the same key, which is the case the key exists for.
 */

export const RESEND_API_URL = 'https://api.resend.com/emails';
/** Points every send at another endpoint — a fake Resend in a test or a rehearsal. Read at each send. */
export const RESEND_API_URL_ENV = 'ORBIT_RESEND_API_URL';
export const RESEND_TIMEOUT_MS = 10_000;

export interface OutgoingEmail {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
}

/**
 * What one attempt came to.
 *  - SENT: Resend took it; `id` is its email id.
 *  - RETRY: worth trying again (429, 5xx, 401/403, a concurrent 409, timeout, network). `answered` says
 *    whether Resend answered at all: an unanswered attempt may have been sent, so it keeps its key.
 *  - FAILED: no retry can help (422 and other 4xx, a 409 for a key used with another payload).
 */
export type SendResult =
  | { outcome: 'SENT'; id: string }
  | { outcome: 'RETRY'; status: number | null; error: string; answered: boolean }
  | { outcome: 'FAILED'; status: number; error: string };

export interface ResendOptions {
  /** Defaults to ORBIT_RESEND_API_URL, else RESEND_API_URL. */
  url?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
}

/** The `message` of a Resend error body, or the raw text when it is not JSON. */
function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; name?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
    if (typeof parsed.name === 'string' && parsed.name) return parsed.name;
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 500) || 'no message';
}

/** Classifies an HTTP answer. Exported for the tests and the admin page's test email. */
export function classify(status: number, body: string): SendResult {
  if (status >= 200 && status < 300) {
    try {
      const parsed = JSON.parse(body) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id) return { outcome: 'SENT', id: parsed.id };
    } catch {
      // fall through
    }
    return { outcome: 'SENT', id: '' };
  }
  const error = `${status} ${errorMessage(body)}`;
  if (status === 429 || status >= 500 || status === 401 || status === 403) return { outcome: 'RETRY', status, error, answered: true };
  if (status === 409 && /concurrent_idempotent_requests/.test(body)) return { outcome: 'RETRY', status, error, answered: true };
  return { outcome: 'FAILED', status, error };
}

export async function sendViaResend(apiKey: string, email: OutgoingEmail, options: ResendOptions = {}): Promise<SendResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'orbit-apiserver',
  };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const body = JSON.stringify({
    from: email.from,
    to: [email.to],
    ...(email.replyTo ? { reply_to: email.replyTo } : {}),
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  let response: Response;
  try {
    response = await fetch(options.url ?? (process.env[RESEND_API_URL_ENV]?.trim() || RESEND_API_URL), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const why = timedOut ? `timed out after ${(options.timeoutMs ?? RESEND_TIMEOUT_MS) / 1000}s` : `network error: ${(err as Error)?.message ?? String(err)}`;
    return { outcome: 'RETRY', status: null, error: why, answered: false };
  }
  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    if (response.ok) return { outcome: 'RETRY', status: response.status, error: `answer cut off: ${(err as Error).message}`, answered: false };
  }
  return classify(response.status, text);
}
