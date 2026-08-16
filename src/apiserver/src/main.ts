import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { publicIdHeaders } from './common/public-id-headers';
import { PublicIdInterceptor } from './common/public-id.interceptor';
import { WorkspaceAliasInterceptor } from './common/workspace-alias.interceptor';

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
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  // Pasted-image turns carry base64 in the JSON body; Nest's default 100kb express
  // limit rejects them with 413. Match the gateway/web nginx client_max_body_size (10m).
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  // The session-context headers carry public ids like every other id position. Before the guards,
  // so no guard can see the un-normalized spelling.
  app.use(publicIdHeaders);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  // Every JSON response carries both `workspace*` and `agent*` while shipped clients still speak
  // the pre-rename name. Temporary — see the interceptor.
  // Alongside it, every public id also goes out in both spellings (`sessionId` +
  // `sessionPublicId`) so clients can move to the short form without a flag day.
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());

  const origins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim());
  app.enableCors({ origin: origins, credentials: true });

  const port = Number(config.get('PORT') ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`orbit control plane listening on :${port}`);
}

void bootstrap();
