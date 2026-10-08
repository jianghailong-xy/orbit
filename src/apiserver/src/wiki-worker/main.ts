import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WikiWorkerModule } from './wiki-worker.module';

/**
 * The wiki-worker service (docs/wiki-server-execution-design.md §4.1 and §4.5, contract `systemModel.service`): the
 * apiserver's image and code, started as `node src/apiserver/dist/wiki-worker/main.js`. An application context rather
 * than an application — Prisma and the worker's providers, no controller, no port. It applies no migration: Compose
 * starts it once the apiserver, which applies them on boot, is healthy.
 *
 * It probes the System model and writes the model's state and its own heartbeat to wiki_model_status
 * (wiki-model-status.ts), runs the model request queue (wiki-model-queue.service.ts) and executes the jobs the
 * executor switch hands it (wiki-job-executor.ts); under the default ORBIT_WIKI_EXECUTOR=runner it claims nothing
 * and only probes.
 *
 * On SIGTERM — `docker compose stop` gives it 30 s — the shutdown hooks stop the probe, let the last write finish and
 * close the database, and then the process exits: in the container it is PID 1, which a signal with no handler left
 * would not end, so the exit is explicit.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WikiWorkerModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks([], { useProcessExit: true });
}

bootstrap().catch((error: unknown) => {
  new Logger('WikiWorker').error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
