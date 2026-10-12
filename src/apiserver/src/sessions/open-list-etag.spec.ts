import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { AutoRetryService } from './auto-retry.service';
import { MergeReceiptService } from './merge-receipt.service';
import { ifNoneMatchHits, openListEtag } from './open-list-version';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * The clients poll `GET /api/sessions?view=open` every few seconds with the ETag they last got.
 * The door answers from the data version alone: while it stands, the reply is a 304 and the list
 * is never read (let alone serialized); when it moves, the list is built and sent with a new ETag.
 * Driven over real HTTP through main.ts's pipe and interceptors, so the 304 is Express's own.
 */

const OWNER_ID = '22222222-2222-4222-8222-222222222222';

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const state = { version: 'v1', listed: 0, versions: 0 };
  const sessions = {
    openListVersion: async (ownerId: string) => {
      assert.equal(ownerId, OWNER_ID);
      state.versions += 1;
      return state.version;
    },
    list: async () => {
      state.listed += 1;
      return [{ id: OWNER_ID, title: `built from ${state.version}` }];
    },
    listOpenSince: async () => ({ full: false, upserts: [], removedIds: [], cursor: 'c1' }),
  };

  @Module({
    controllers: [SessionsController],
    providers: [
      { provide: SessionsService, useValue: sessions },
      { provide: PrismaService, useValue: {} },
      { provide: RealtimeService, useValue: {} },
      { provide: SessionTagsService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
      { provide: AutoRetryService, useValue: {} },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER_ID }) } },
    ],
  })
  class OpenListHarness {}

  const app = await NestFactory.create(OpenListHarness, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  async function get(query: string, ifNoneMatch?: string) {
    const response = await fetch(`${base}/api/sessions${query}`, {
      headers: {
        authorization: 'Bearer owner',
        'accept-encoding': 'gzip',
        ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
      },
    });
    return { status: response.status, etag: response.headers.get('etag'), body: await response.text() };
  }
  /** As the native clients ask: no `Cache-Control` beside the If-None-Match (fetch() adds one). */
  function getPlain(query: string, ifNoneMatch: string) {
    return new Promise<{ status: number; etag: string | undefined; body: string }>((resolve, reject) => {
      const req = request(`${base}/api/sessions${query}`, {
        headers: { authorization: 'Bearer owner', 'if-none-match': ifNoneMatch },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, etag: res.headers.etag, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  return { state, get, getPlain };
}

test('an unchanged version answers 304 without reading or serializing the list', async (t) => {
  const { state, get, getPlain } = await harness(t);
  const first = await get('?view=open');
  assert.equal(first.status, 200);
  assert.match(first.etag ?? '', /^W\/"ol1-[A-Za-z0-9_-]+"$/);
  assert.match(first.body, /built from v1/);
  assert.equal(state.listed, 1);

  for (let i = 0; i < 3; i += 1) {
    const again = await get('?view=open', first.etag!);
    assert.equal(again.status, 304);
    assert.equal(again.body, '');
    assert.equal(again.etag, first.etag, 'a 304 carries the ETag it confirms');
  }
  const plain = await getPlain('?view=open', first.etag!);
  assert.equal(plain.status, 304);
  assert.equal(plain.body, '');
  assert.equal(state.listed, 1, 'a matching If-None-Match still built the list');
  assert.equal(state.versions, 5);
});

test('a moved version answers 200 with the list and a new ETag', async (t) => {
  const { state, get } = await harness(t);
  const first = await get('?view=open');
  state.version = 'v2';
  const second = await get('?view=open', first.etag!);
  assert.equal(second.status, 200);
  assert.notEqual(second.etag, first.etag);
  assert.match(second.body, /built from v2/);
  assert.equal(state.listed, 2);
  // And the new ETag is the one that hits from then on.
  assert.equal((await get('?view=open', second.etag!)).status, 304);
  assert.equal(state.listed, 2);
});

test('the same data always yields the same ETag, and a different list never shares it', async (t) => {
  const { get } = await harness(t);
  const open = await get('?view=open');
  assert.equal((await get('?view=open')).etag, open.etag);
  // Without `view` it is the same Open list, so the same ETag.
  assert.equal((await get('')).etag, open.etag);
  // A filtered or paged list is a different body: its ETag must not hit the whole list's.
  const paged = await get('?view=open&limit=50');
  assert.notEqual(paged.etag, open.etag);
  assert.equal((await get('?view=open&limit=50', open.etag!)).status, 200);
});

test('other views keep the body-hash ETag and never consult the version', async (t) => {
  const { state, get } = await harness(t);
  const completed = await get('?view=completed');
  assert.equal(completed.status, 200);
  assert.doesNotMatch(completed.etag ?? '', /ol1-/);
  assert.equal(state.versions, 0);
});

test('a delta poll (`since`) is the delta store\'s to answer, not the version\'s', async (t) => {
  const { state, get } = await harness(t);
  const delta = await get('?view=open&since=c0');
  assert.equal(delta.status, 200);
  assert.match(delta.body, /"cursor":"c1"/);
  assert.doesNotMatch(delta.etag ?? '', /ol1-/);
  assert.equal(state.versions, 0);
});

test('If-None-Match is compared weakly and may list several tags', () => {
  const etag = openListEtag('abc', {});
  assert.equal(etag, 'W/"ol1-abc"');
  assert.ok(ifNoneMatchHits('W/"ol1-abc"', etag));
  assert.ok(ifNoneMatchHits('"ol1-abc"', etag));
  assert.ok(ifNoneMatchHits('W/"other", W/"ol1-abc"', etag));
  assert.ok(!ifNoneMatchHits('W/"ol1-abd"', etag));
  assert.ok(!ifNoneMatchHits(undefined, etag));
});
