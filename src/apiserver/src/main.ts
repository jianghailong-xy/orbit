import 'reflect-metadata';
import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { drainable, type DrainableServer, DRAIN_MS, endStreams, STOP_MS } from './common/graceful-stop';
import { holdIdleConnections } from './common/idle-connections';
import { PublicIdExceptionFilter } from './common/public-id.filter';
import { publicIdHeaders } from './common/public-id-headers';
import { PublicIdInterceptor } from './common/public-id.interceptor';
import { RunnerLinkErrorFilter } from './common/runner-link-error.filter';
import { SlowRequestInterceptor } from './common/slow-request.interceptor';
import { TransientDbConflictFilter } from './common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from './common/workspace-alias.interceptor';
import { outsideThePoolGateway } from './providers/pool-gateway.controller';
import { listenForRunnerLinkCalls } from './runner-api/runner-link-call';

declare global {
  interface BigInt {
    toJSON(): string;
  }
}
// Prisma maps BIGINT columns (e.g. Workspace.workDirFreeBytes) to native BigInt, which
// JSON.stringify throws on by default — every response that spreads a row with one of these
// columns 500s. JSON.stringify calls toJSON() when present, so this makes BigInt serialize
// like any other value instead of crashing the whole endpoint.
BigInt.prototype.toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  // Listened for from the start, so that a SIGTERM during boot is not lost: as PID 1, node ignores a signal it has no
  // handler for. The stop waits for boot to finish first (common/graceful-stop.ts).
  let started: (ready: { app: INestApplication; listeners: DrainableServer[] }) => void = () => undefined;
  const ready = new Promise<{ app: INestApplication; listeners: DrainableServer[] }>((resolve) => (started = resolve));
  stopOnSignals(ready);

  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  // Pasted-image turns carry base64 in the JSON body; Nest's default 100kb express
  // limit rejects them with 413. Match the gateway/web nginx client_max_body_size (10m).
  // Not for the shared pools' gateway, which forwards the body codex sent unread (pool-gateway.controller.ts).
  app.use(outsideThePoolGateway(json({ limit: '10mb' })));
  app.use(outsideThePoolGateway(urlencoded({ extended: true, limit: '10mb' })));

  // The session-context headers carry public ids like every other id position. Before the guards,
  // so no guard can see the un-normalized spelling.
  app.use(publicIdHeaders);

  // No answer is ever read as something other than what it says it is. The page policy lets any of this
  // origin's files run as a script (src/web/nginx.conf), and this is what holds an answer under /api/ to
  // its own type: a browser refuses a script whose type is not JavaScript only when nosniff is on it.
  app.use((_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  // Every JSON response carries both `workspace*` and `agent*` while shipped clients still speak
  // the pre-rename name. Temporary — see the interceptor.
  // Alongside it, every public id also goes out in both spellings (`sessionId` +
  // `sessionPublicId`) so clients can move to the short form without a flag day.
  // The slow-request line is FIRST so its clock covers what the two mappers beside it do — the
  // time a request is worth reporting is the time the client waited, not the handler's own.
  app.useGlobalInterceptors(
    new SlowRequestInterceptor(),
    new WorkspaceAliasInterceptor(),
    new PublicIdInterceptor(),
  );
  // A response body leaves by one of two doors, and both spell ids the same way. The interceptor
  // above maps what a handler returns; this maps what it throws, which used to leave raw UUIDs in
  // refusal bodies on endpoints whose success bodies were base62.
  //
  // In front of it, and chained INTO it rather than registered beside it: Nest runs exactly one
  // filter per exception, so two catch-alls would not compose — the second would simply replace
  // the first. The conflict boundary answers a database that rolled a request back and hands
  // everything else straight through, so the id rule still applies to every refusal. Between the
  // two, a runner link call's answer gets the link's error fields and a database resource fault its
  // retryable 503; every other request passes it untouched (runner-link-error.filter.ts).
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(
    new TransientDbConflictFilter(
      new RunnerLinkErrorFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter),
      httpAdapter,
    ),
  );

  const origins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim());
  app.enableCors({ origin: origins, credentials: true });

  const port = Number(config.get('PORT') ?? 3000);
  // Idle connections are held longer than any caller holds them (common/idle-connections.ts).
  holdIdleConnections(app.getHttpServer());
  const listeners = [drainable(app.getHttpServer())];
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`orbit control plane listening on :${port}`);
  // The link gateway's own door to the same routes, when the runner link is on (runner-link-call.ts).
  const linkServer = await listenForRunnerLinkCalls(app, {
    port: config.get<string>('RUNNER_LINK_INTERNAL_PORT'),
    host: config.get<string>('RUNNER_LINK_INTERNAL_HOST'),
  });
  if (linkServer) listeners.push(drainable(linkServer));
  started({ app, listeners });
}

/**
 * On SIGTERM (`docker stop`) or SIGINT, the stop common/graceful-stop.ts describes: both listeners stop accepting,
 * the streams end, what is in flight is answered for up to DRAIN_MS, then Nest's shutdown hooks close the rest. It
 * exits 0 once stopped, and 1 if it has not stopped within STOP_MS. A second signal changes nothing.
 */
function stopOnSignals(ready: Promise<{ app: INestApplication; listeners: DrainableServer[] }>): void {
  const log = new Logger('Stop');
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const began = Date.now();
    setTimeout(() => {
      log.error(`${signal}: not stopped after ${STOP_MS} ms; exiting`);
      process.exit(1);
    }, STOP_MS).unref();
    const { app, listeners } = await ready;
    const inFlight = listeners.reduce((n, l) => n + l.inFlight(), 0);
    log.log(`${signal}: stopping; no new connections, ${inFlight} request(s) in flight, streams ending`);
    const drained = Promise.all(listeners.map((l) => l.drain(began + DRAIN_MS)));
    endStreams();
    const cut = (await drained).reduce((n, c) => n + c, 0);
    log.log(
      `listeners closed after ${Date.now() - began} ms` +
        (cut > 0 ? `; ${cut} request(s) still unanswered after ${DRAIN_MS} ms were cut` : '; every request answered'),
    );
    await app.close();
    log.log(`stopped in ${Date.now() - began} ms`);
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void stop(signal));
}

void bootstrap();
