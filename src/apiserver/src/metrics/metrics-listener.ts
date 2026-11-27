import { createServer, STATUS_CODES, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type INestApplication, Logger } from '@nestjs/common';

import { holdIdleConnections } from '../common/idle-connections';
import { PrismaService } from '../prisma/prisma.service';
import { renderMetrics } from './metrics.controller';

/**
 * The listener Prometheus scrapes (docs/self-hosting.md, "Monitoring"): the body of `GET /api/metrics`, without its
 * bearer token, on a port of its own that serves `/metrics` and nothing else. It never hands a request to the app, so
 * no route, guard or handler of the API is reachable through it, whatever the path.
 *
 * In Compose it binds every interface of the container, so Prometheus reaches each apiserver over the project's network
 * by the `orbit-apiservers` name; the port is published nowhere. A managed runner cannot reach it either: its network
 * is another Docker bridge, which Docker keeps apart from this one with or without `managed-runner-firewall`. That is
 * why it carries no token. The JWT route (metrics.controller.ts) stays as it was, for an operator with a token.
 *
 * It stops with the public listener: main.ts drains it with the others on SIGTERM (common/graceful-stop.ts).
 */

/** Where the listener binds unless METRICS_INTERNAL_HOST says otherwise. */
export const METRICS_INTERNAL_DEFAULT_HOST = '127.0.0.1';

/** The one path it serves. */
export const METRICS_PATH = '/metrics';

/** The listener's door: `GET` or `HEAD` of `/metrics`, with any query; every other path 404, every other method 405. */
export function metricsScrapeListener(
  render: () => Promise<string>,
  log: Pick<Logger, 'error'> = new Logger('MetricsListener'),
): RequestListener {
  return (req, res) => {
    const path = (req.url ?? '').split('?', 1)[0];
    if (path !== METRICS_PATH) {
      return refuse(res, 404, 'METRICS_ROUTE_UNKNOWN', 'This listener serves GET /metrics only.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return refuse(res, 405, 'METRICS_METHOD_NOT_ALLOWED', 'This listener serves GET /metrics only.');
    }
    render().then(
      (body) => {
        res.writeHead(200, {
          // What GET /api/metrics answers with (metrics.controller.ts), which a scraper and promtool parse.
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      },
      (error: unknown) => {
        log.error(`metrics could not be read: ${(error as Error).message}`);
        refuse(res, 500, 'METRICS_UNAVAILABLE', 'The metrics could not be read.');
      },
    );
  };
}

function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ statusCode: status, error: STATUS_CODES[status], code, message });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Opens the listener when METRICS_INTERNAL_PORT is set. It binds METRICS_INTERNAL_HOST, 127.0.0.1 unless set. A setting
 * that cannot be used leaves it closed and says why once; the public listener never depends on it.
 */
export async function listenForMetricsScrapes(
  app: INestApplication,
  settings: { port?: string; host?: string },
  log: Pick<Logger, 'log' | 'error'> = new Logger('MetricsListener'),
): Promise<Server | null> {
  const portText = settings.port?.trim() ?? '';
  if (portText === '') return null;
  const port = /^[0-9]{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!(port <= 65_535)) {
    log.error(`METRICS_INTERNAL_PORT=${JSON.stringify(portText)} is not a port: metrics are not served for scraping`);
    return null;
  }
  const host = settings.host?.trim() || METRICS_INTERNAL_DEFAULT_HOST;
  const prisma = app.get(PrismaService, { strict: false });
  // Idle connections are held longer than Prometheus, which scrapes every 15 s, leaves one idle (common/idle-connections.ts).
  const server = holdIdleConnections(createServer(metricsScrapeListener(() => renderMetrics(prisma), log)));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    log.error(`metrics are not served for scraping: listening on ${host}:${port} failed (${(error as Error).message})`);
    return null;
  }
  log.log(`metrics are served for scraping on ${host}:${(server.address() as AddressInfo).port}${METRICS_PATH}`);
  return server;
}
