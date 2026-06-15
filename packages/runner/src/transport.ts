import {
  ClaimedJob,
  RunCompleteRequest,
  RunEventBatch,
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
} from '@orbit/shared';

/** Outbound-only HTTP client to the control plane. Uses Node's global fetch. */
export class Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private async req<T>(
    path: string,
    method: string,
    body?: unknown,
    timeoutMs = 35_000,
  ): Promise<T | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${method} ${path} -> ${res.status} ${text}`);
      }
      const text = await res.text();
      return text ? (JSON.parse(text) as T) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  register(body: RunnerRegisterRequest): Promise<RunnerRegisterResponse | null> {
    return this.req<RunnerRegisterResponse>('/runner/register', 'POST', body);
  }

  heartbeat(body: RunnerHeartbeatRequest): Promise<RunnerHeartbeatResponse | null> {
    return this.req<RunnerHeartbeatResponse>('/runner/heartbeat', 'POST', body);
  }

  // Long-poll: server may hold the request up to ~25s.
  claimJob(): Promise<ClaimedJob | null> {
    return this.req<ClaimedJob>('/runner/jobs', 'GET', undefined, 35_000);
  }

  postEvents(runId: string, batch: RunEventBatch): Promise<unknown> {
    return this.req(`/runner/runs/${runId}/events`, 'POST', batch);
  }

  complete(runId: string, body: RunCompleteRequest): Promise<unknown> {
    return this.req(`/runner/runs/${runId}/complete`, 'POST', body);
  }
}
