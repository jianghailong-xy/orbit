import { Controller, Get, Header } from '@nestjs/common';

/**
 * Liveness for the control plane itself: `GET /api/health`.
 *
 * Deliberately UNAUTHENTICATED, unlike `MetricsController` next door. The callers are probes —
 * an uptime monitor, a load balancer, a container healthcheck — and none of them carries a bearer
 * token; a guard here would make every one of them read a healthy server as a failed one. The
 * trade is safe because the answer is a constant: it names no user, no session and no row, and
 * says nothing an unauthenticated caller could not already learn by getting any HTTP response at
 * all out of this port.
 *
 * It answers for THIS PROCESS ONLY — the HTTP stack is up and the event loop is turning. It
 * deliberately does not touch the database, because readiness and liveness fail in opposite
 * directions: a probe that goes red on a transient database blip takes a still-serving process
 * out of rotation, which is the more expensive mistake. A readiness check that reports on
 * dependencies is a separate route with a separate contract.
 *
 * Distinct from the `/healthz` that nginx answers in `gateway/nginx.conf` and `src/web/nginx.conf`:
 * those are served by the proxies themselves and stay 200 while this process is dead.
 */
@Controller('health')
export class HealthController {
  @Get()
  // A cached 200 is a probe that keeps reporting a dead server as healthy.
  @Header('Cache-Control', 'no-store')
  read(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
