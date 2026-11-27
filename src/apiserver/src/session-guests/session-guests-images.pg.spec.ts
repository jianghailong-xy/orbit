/**
 * Session guests, images (docs/session-guests-design.md §5), held against the production apiserver — `build/main.js`,
 * the whole AppModule behind JwtAuthGuard — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   (1) allowed: the guest uploads a PNG through `POST /guest-sessions/:id/attachments` and sends it with words, then
 *       one alone; each is one turn of the owner's session with the image linked to it, each counts once toward the
 *       guest's day, and the runner the session runs on is handed that turn's image by its inbox and reads its bytes —
 *       what the owner's agent is given for an owner turn;
 *   (2) the upload door takes only the owner composer's images: a PDF, a text file called a PNG and an image over 5 MB
 *       are refused, and nothing is kept; a stranger meets the one 404;
 *   (3) a turn names only the guest's own images of this session: the owner's image, another guest's, the guest's own
 *       image of another session and a non-image file each are refused by name, and nothing is written;
 *   (4) a message with images at the day's cap is the 429 any message is, and its image stays unsent.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/session-guests/session-guests-images.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { type PrismaClient, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { GUEST_IMAGE_TOO_LARGE, GUEST_IMAGE_TYPE_REFUSED, MAX_COMPOSER_IMAGE_BYTES } from '../attachments/attachments.media';
import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
// The runner's own routes over plain HTTP, as the link gateway would forward them: this spec is about what the inbox hands out.
import '../test-support/daemon-routes-over-http';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import {
  GUEST_DAILY_CAP_REACHED, GUEST_DAILY_TURNS, GUEST_SESSION_NOT_SHARED, guestAttachmentRefused,
} from './session-guests.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const ENGINES = [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }];

/** A PNG's signature and IHDR, then `tail`: what the guest door's first-bytes check reads. */
const png = (tail: string | Buffer) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.isBuffer(tail) ? tail : Buffer.from(tail),
]);

/** POST one file as multipart, as a browser's FormData sends it. */
async function upload(server: Apiserver, route: string, bearer: string, name: string, type: string, bytes: Buffer): Promise<Reply> {
  const boundary = `guest-images-${randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetch(`http://127.0.0.1:${server.port}/api${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: {} } as Reply;
}

test('session guests: a guest attaches images they uploaded, and only those', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const db: PrismaClient = prismaClientFor(url);
  // The uploads' bytes, in a directory of this run's own: the default (/var/lib/orbit/files) is one a CI runner's user
  // cannot create, which answered every upload 500 there.
  const filesDir = mkdtempSync(path.join(tmpdir(), 'orbit-guest-images-'));
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    rmSync(filesDir, { recursive: true, force: true });
  });

  const person = async (label: string) => {
    const id = randomUUID();
    const email = `images-${label}-${RUN}-${id}@session-guests.invalid`;
    const name = `${label[0]!.toUpperCase()}${label.slice(1)} ${RUN}`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, email, name };
  };
  const owner = await person('owner');
  const guest = await person('alice');
  const other = await person('ravi');
  const stranger = await person('stranger');

  const jwtSecret = `session-guests-images-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  const loginOf = (p: { id: string; email: string }) => jwt.signAsync({ sub: p.id, email: p.email });
  const [ownerLogin, guestLogin, otherLogin, strangerLogin] = await Promise.all([owner, guest, other, stranger].map(loginOf));
  server = await startApiserver(url, jwtSecret, { ORBIT_DRIVE_BACKEND: 'local', ORBIT_DRIVE_DIR: filesDir });
  const api = (method: string, path: string, bearer: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body, headers);
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
    return reply;
  };

  // The owner's machine, registered as `orbit register --token` does, so its inbox is the real runner door.
  const minted = ok(await api('POST', '/runners/enrollment-tokens', ownerLogin, { label: `guest images ${RUN}` }), 'minting an enrollment token');
  const registered = await call(server, 'POST', '/api/runner/register', undefined,
    { enrollmentToken: minted.json.token, name: `images-${RUN}`, hostname: `images-${RUN}` });
  assert.equal(registered.status, 201, registered.text);
  const runner = { id: toUuid(registered.json.runnerId), token: registered.json.runnerToken as string };
  const runnerApi = (method: string, path: string, body?: unknown) =>
    call(server!, method, `/api/runner${path}`, runner.token, body);
  ok(await runnerApi('POST', '/heartbeat', { status: 'ONLINE', engines: ENGINES }), 'the runner heartbeat');
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId: owner.id, runnerId: runner.id, name: `images ${RUN}`, enabled: true } });

  /** A session of the owner's that has run a turn and waits for its next message. */
  const session = async (title: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId: owner.id, creatorId: owner.id, workspaceId, assignedRunnerId: runner.id, title, prompt: title,
        provider: 'claude', providerBuiltin: true, model: 'claude-opus-4-1', permissionMode: 'acceptEdits',
        dispatchOrigin: SessionDispatchOrigin.USER, turnState: null, numTurns: 1, engineTurnActive: false,
        runtimeSessionId: randomUUID(), startedAt: new Date(),
      },
    });
    return id;
  };
  const invite = async (sessionId: string, who: { email: string }) =>
    ok(await api('POST', `/sessions/${sessionId}/guests`, ownerLogin, { email: who.email }), 'inviting');
  const uploadAs = (bearer: string, sessionId: string, name: string, type: string, bytes: Buffer) =>
    upload(server!, `/guest-sessions/${sessionId}/attachments`, bearer, name, type, bytes);
  const send = (sessionId: string, body: Record<string, unknown>, bearer = guestLogin) =>
    api('POST', `/guest-sessions/${sessionId}/turns`, bearer, { clientTurnId: randomUUID(), ...body });
  const counter = async (sessionId: string) =>
    (await db.sessionGuest.findFirstOrThrow({ where: { sessionId, userId: guest.id, removedAt: null }, select: { turnsOnDay: true } })).turnsOnDay;
  const guestTurns = (sessionId: string) =>
    db.conversationTurn.count({ where: { sessionId, externalSenderSource: 'ORBIT_GUEST', externalSenderId: guest.id } });

  const live = await session('a conversation with a screenshot');
  await invite(live, guest);
  await invite(live, other);

  await t.test('(1) allowed: the guest’s image goes out with their words, and alone; the owner’s agent is handed it', async () => {
    const picture = png(`screenshot-${RUN}`);
    const uploaded = ok(await uploadAs(guestLogin, live, 'screenshot.png', 'image/png', picture), 'uploading a PNG');
    const imageId = toUuid(uploaded.json.id);
    const row = await db.attachment.findUniqueOrThrow({ where: { id: imageId } });
    assert.deepEqual(
      [row.ownerId, row.sessionId, row.uploadedByGuestId, row.mimeType, row.sizeBytes, row.turnId],
      [owner.id, live, guest.id, 'image/png', picture.length, null],
      "a row of the owner's session that names the guest, not yet on a turn",
    );

    const before = await counter(live);
    const sent = ok(await send(live, { content: 'Here is what I see', attachmentIds: [uuidToBase62(imageId)] }), 'sending it with words');
    const turnId = toUuid(sent.json.turnId);
    const turn = await db.conversationTurn.findUniqueOrThrow({ where: { id: turnId }, select: { content: true, externalSenderId: true, kind: true } });
    assert.deepEqual([turn.kind, turn.content, turn.externalSenderId], ['message', 'Here is what I see', guest.id]);
    assert.equal((await db.attachment.findUniqueOrThrow({ where: { id: imageId } })).turnId, turnId, 'the image is linked to the turn');
    assert.equal(await counter(live), before + 1, 'a message with an image counts once');

    // The runner takes the session as it takes any, and its inbox hands it this turn with the image.
    const claim = ok(await runnerApi('GET', '/sessions/claim'), 'the runner claiming');
    assert.equal(toUuid(claim.json?.sessionId ?? '00000000-0000-0000-0000-000000000000'), live, claim.text.slice(0, 400));
    const current = await db.session.findUniqueOrThrow({ where: { id: live }, select: { inboxLeaseOwner: true } });
    const leaseOwner = randomUUID();
    ok(await runnerApi('POST', `/sessions/${live}/takeover-leases`, { leaseOwner, expectedLeaseOwner: current.inboxLeaseOwner }), 'taking the inbox over');
    const leaseGeneration = randomUUID();
    ok(await runnerApi('POST', `/sessions/${live}/activate-leases`, { leaseOwner, leaseGeneration }), 'activating a generation');
    const handed = ok(await runnerApi('GET', `/sessions/${live}/inbox?leaseGeneration=${leaseGeneration}`), 'the inbox');
    assert.equal(toUuid(handed.json.turnId), turnId, handed.text);
    assert.equal(handed.json.content, 'Here is what I see');
    assert.deepEqual(
      (handed.json.attachments as { id: string; mimeType: string }[]).map((a) => [toUuid(a.id), a.mimeType]),
      [[imageId, 'image/png']],
      "the turn's image, as an owner turn's are handed over",
    );
    const bytes = ok(await runnerApi('GET', `/sessions/${live}/attachments/${imageId}`), 'the runner reading the image');
    assert.equal(bytes.text, picture.toString('utf8'), 'and its bytes');
    await db.conversationTurn.update({ where: { id: turnId }, data: { status: 'ANSWERED' } });

    // An image on its own is a message too, as an owner's may be.
    const alone = toUuid(ok(await uploadAs(guestLogin, live, 'alone.png', 'image/png', png(`alone-${RUN}`)), 'uploading another').json.id);
    const onlyImage = ok(await send(live, { content: '', attachmentIds: [alone] }), 'sending an image alone');
    assert.equal((await db.attachment.findUniqueOrThrow({ where: { id: alone } })).turnId, toUuid(onlyImage.json.turnId));
    assert.equal(await counter(live), before + 2, 'one more message, one more toward the day');
    // Words or images are still required.
    const empty = await send(live, { content: '   ', attachmentIds: [] });
    assert.equal(empty.status, 400, empty.text);
  });

  await t.test('(2) the upload door takes only the owner composer’s images, and a stranger meets the one 404', async () => {
    const kept = () => db.attachment.count({ where: { sessionId: live } });
    const before = await kept();
    const pdf = await uploadAs(guestLogin, live, 'notes.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n'));
    assert.equal(pdf.status, 400, pdf.text);
    assert.equal(pdf.json.message, GUEST_IMAGE_TYPE_REFUSED);
    const disguised = await uploadAs(guestLogin, live, 'notes.png', 'image/png', Buffer.from('not a picture at all'));
    assert.equal(disguised.status, 400, disguised.text);
    assert.equal(disguised.json.message, GUEST_IMAGE_TYPE_REFUSED);
    const svg = await uploadAs(guestLogin, live, 'logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    assert.equal(svg.status, 400, svg.text);
    const large = await uploadAs(guestLogin, live, 'large.png', 'image/png', png(Buffer.alloc(MAX_COMPOSER_IMAGE_BYTES)));
    assert.equal(large.status, 413, large.text);
    assert.equal(large.json.message, GUEST_IMAGE_TOO_LARGE);
    const stranger = await uploadAs(strangerLogin, live, 'hello.png', 'image/png', png('hello'));
    assert.equal(stranger.status, 404, stranger.text);
    assert.equal(stranger.json.message, GUEST_SESSION_NOT_SHARED);
    assert.equal(await kept(), before, 'nothing was kept');
  });

  await t.test('(3) a turn names only the guest’s own images of this session; anything else is refused by name', async () => {
    const elsewhere = await session('another conversation');
    await invite(elsewhere, guest);
    const theirsElsewhere = toUuid(ok(await uploadAs(guestLogin, elsewhere, 'there.png', 'image/png', png('there')), 'an image of another session').json.id);
    const others = toUuid(ok(await uploadAs(otherLogin, live, 'ravi.png', 'image/png', png('ravi')), "another guest's image").json.id);
    const picture = png('owner');
    const owners = (await db.attachment.create({
      data: { ownerId: owner.id, sessionId: live, mimeType: 'image/png', sizeBytes: picture.length, data: picture },
      select: { id: true },
    })).id;
    const notImage = Buffer.from('%PDF-1.7\n');
    const pdf = (await db.attachment.create({
      data: { ownerId: owner.id, sessionId: live, uploadedByGuestId: guest.id, mimeType: 'application/pdf', sizeBytes: notImage.length, data: notImage },
      select: { id: true },
    })).id;
    const mine = toUuid(ok(await uploadAs(guestLogin, live, 'mine.png', 'image/png', png('mine')), 'the guest’s own').json.id);

    const turnsBefore = await guestTurns(live);
    const countedBefore = await counter(live);
    for (const [what, id] of [['the owner’s image', owners], ['another guest’s image', others], ['the guest’s image of another session', theirsElsewhere], ['a non-image file', pdf], ['no attachment at all', randomUUID()]] as const) {
      // Beside one of the guest's own, so it is the foreign one that is named.
      const reply = await send(live, { content: 'look', attachmentIds: [mine, id] });
      assert.equal(reply.status, 400, `${what}: ${reply.text}`);
      assert.equal(reply.json.message, guestAttachmentRefused(uuidToBase62(id)), what);
    }
    assert.equal(await guestTurns(live), turnsBefore, 'no turn was written');
    assert.equal(await counter(live), countedBefore, 'nothing counted toward the day');
    const stillLoose = await db.attachment.findMany({ where: { id: { in: [mine, owners, others, theirsElsewhere, pdf] } }, select: { turnId: true } });
    assert.ok(stillLoose.every((a) => a.turnId === null), 'no attachment was linked');
    ok(await send(live, { content: 'look', attachmentIds: [mine] }), 'the guest’s own still goes');
  });

  await t.test('(4) a message with images at the day’s cap is refused as any message is', async () => {
    const capped = await session('the cap, with images');
    await invite(capped, guest);
    const image = toUuid(ok(await uploadAs(guestLogin, capped, 'cap.png', 'image/png', png('cap')), 'an image').json.id);
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    await db.sessionGuest.updateMany({ where: { sessionId: capped, userId: guest.id, removedAt: null }, data: { turnDay: today, turnsOnDay: GUEST_DAILY_TURNS } });
    const refused = await send(capped, { content: 'one more', attachmentIds: [image] });
    assert.equal(refused.status, 429, refused.text);
    assert.equal(refused.json.message, GUEST_DAILY_CAP_REACHED);
    assert.equal((await db.attachment.findUniqueOrThrow({ where: { id: image } })).turnId, null, 'the image stays unsent');
    assert.equal(await guestTurns(capped), 0);
  });
});
