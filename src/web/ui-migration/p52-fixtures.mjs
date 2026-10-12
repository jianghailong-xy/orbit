import { deflateSync } from 'node:zlib';
import { FIXED_NOW } from './fixtures.mjs';
import { SESSION, SESSION_PATH } from './session-fixtures.mjs';

// P5.2 data: the P0 conversation's transcript replaced by one that carries every kind of picture the transcript
// draws — a user turn's attachments (fetched with the bearer through /api/attachments, then shown from an object
// URL), a reply's Markdown images (an attachment, and a legacy artifact path fetched through the session's artifact
// route), tool results with an inline screenshot and one whose bytes the server clipped (refetched whole when its
// card opens), an attachment and an artifact that fail, and an undelivered message whose image is put back into the
// composer. The same conversation is also shared by a session link, whose page fetches the same bytes through the
// public routes. Registered on top of installFixtures (later routes win), so every path not modeled here falls
// through to the P0 handler and its unhandled-request check. `state` is read on every request, so a test holds or
// changes an answer before the step that asks. Synthetic, public test data only.

// ── deterministic pictures ───────────────────────────────────────────────────────────────────────
// Four coloured quadrants, a dark marker in the top-left corner and a light frame: a rotation or a flip moves the
// marker to another corner, so a screenshot shows which way a picture was turned.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
function png(width, height, colours) {
  const [tl, tr, bl, br] = colours.map(hex);
  const frame = hex('#f4f5f7');
  const marker = hex('#1f2329');
  const rows = [];
  const edge = Math.max(4, Math.round(Math.min(width, height) / 40));
  const mark = Math.round(Math.min(width, height) / 6);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      let rgb = y < height / 2 ? (x < width / 2 ? tl : tr) : x < width / 2 ? bl : br;
      if (x < edge || y < edge || x >= width - edge || y >= height - edge) rgb = frame;
      else if (x < edge + mark && y < edge + mark) rgb = marker;
      row.set(rgb, 1 + x * 3);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Each picture's size names it: what a step records of the picture on screen.
export const P52_SIZES = {
  '640x400': 'userWide', '300x600': 'userTall', '1180x768': 'result', '480x320': 'markdown', '800x500': 'artifact',
  '520x520': 'later', '900x600': 'clipped', '400x250': 'putBack',
};

export const P52_IMAGES = {
  userWide: png(640, 400, ['#f54a45', '#2ea121', '#3370ff', '#ff8800']),
  userTall: png(300, 600, ['#7f3bf5', '#ff8800', '#14c0c0', '#f5319d']),
  result: png(1180, 768, ['#3370ff', '#eceef1', '#646a73', '#2ea121']),
  markdown: png(480, 320, ['#2ea121', '#f54a45', '#ff8800', '#3370ff']),
  artifact: png(800, 500, ['#14c0c0', '#7f3bf5', '#f5319d', '#646a73']),
  later: png(520, 520, ['#ff8800', '#3370ff', '#f54a45', '#2ea121']),
  clipped: png(900, 600, ['#646a73', '#14c0c0', '#2ea121', '#7f3bf5']),
  putBack: png(400, 250, ['#f5319d', '#2ea121', '#3370ff', '#ff8800']),
};

// ── the conversation ───────────────────────────────────────────────────────────────────────────────
// Attachment ids are opaque to the transcript; these read as what they are in a request log.
export const P52_IDS = {
  userWide: 'p52-user-wide', userTall: 'p52-user-tall', markdown: 'p52-markdown', later: 'p52-later',
  missing: 'p52-missing', putBack: 'p52-put-back',
};
const WORKTREE = '/root/.orbit/worktrees/0196e000-0000-7000-8000-000000000010';
export const P52_ARTIFACTS = { mock: `${WORKTREE}/docs/mocks/p52-mock.png`, gone: `${WORKTREE}/docs/mocks/p52-gone.png` };
export const P52_TOKEN = 'uiMigrationP52Session20260928';
export const P52_PATHS = { session: SESSION_PATH, shared: `/s/${P52_TOKEN}`, tasks: '/tasks' };
const TURN = (n) => `0196e000-0000-7000-8000-0000000052${String(n).padStart(2, '0')}`;
const at = (minutes) => new Date(Date.parse(FIXED_NOW) - (60 - minutes) * 60_000).toISOString();
const imageBlock = (bytes) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });
const attachment = (id, name) => ({ id, mime: 'image/png', name });

export const P52_EVENTS = [
  { seq: 1, type: 'user', turnId: TURN(1), ts: at(1),
    payload: { text: 'Here are the two screens I mentioned.', attachments: [attachment(P52_IDS.userWide, 'wide.png'), attachment(P52_IDS.userTall, 'tall.png')] } },
  { seq: 2, type: 'assistant', turnId: TURN(1), ts: at(2),
    payload: { text: `Both screens keep the layout. The diagram you attached:\n\n![Layout diagram](orbit-attachment:${P52_IDS.markdown})\n\nAnd the mock I drew:\n\n![Mock](${P52_ARTIFACTS.mock})` } },
  { seq: 3, type: 'tool_use', turnId: TURN(1), ts: at(3), payload: { id: 'toolu_p52_read', name: 'Read', input: { file_path: '/tmp/p52/screenshot.png' } } },
  { seq: 4, type: 'tool_result', turnId: TURN(1), ts: at(3), payload: { toolUseId: 'toolu_p52_read', content: [imageBlock(P52_IMAGES.result)] } },
  { seq: 5, type: 'turn_end', turnId: TURN(1), ts: at(4), payload: {} },
  { seq: 6, type: 'user', turnId: TURN(2), ts: at(10),
    payload: { text: 'One more, and one that is missing.', attachments: [attachment(P52_IDS.later, 'later.png'), attachment(P52_IDS.missing, 'missing.png')] } },
  { seq: 7, type: 'assistant', turnId: TURN(2), ts: at(11),
    payload: { text: `The missing one never reached the server. This mock is gone as well:\n\n![Gone mock](${P52_ARTIFACTS.gone})` } },
  { seq: 8, type: 'tool_use', turnId: TURN(2), ts: at(12), payload: { id: 'toolu_p52_clip', name: 'Read', input: { file_path: '/tmp/p52/full-page.png' } } },
  // The server clipped this picture's bytes (MAX_IMAGE_PAYLOAD): the block keeps its type, so the card opens on it and
  // fetches the whole payload.
  { seq: 9, type: 'tool_result', turnId: TURN(2), ts: at(12), truncated: true,
    payload: { toolUseId: 'toolu_p52_clip', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png' } }] } },
  { seq: 10, type: 'turn_end', turnId: TURN(2), ts: at(13), payload: {} },
  { seq: 11, type: 'user', turnId: TURN(3), ts: at(20),
    payload: { text: 'Retry this with the screenshot.', delivery: 'failed', attachments: [attachment(P52_IDS.putBack, 'retry.png')] } },
];
// A turn written while the conversation is open: a user turn with a picture, the reply streaming, a tool's screenshot in
// the middle of it, and the reply settling (p52Stream).
const LIVE = { turnId: TURN(4), ts: at(30) };
export const P52_STREAM = {
  start: [
    { ...LIVE, seq: 12, type: 'user', payload: { text: 'A screenshot while you write.', attachments: [attachment(P52_IDS.later, 'later.png')] } },
    { ...LIVE, seq: 13, type: 'text_delta', payload: { text: 'Looking at the screenshot' } },
  ],
  tool: [
    { ...LIVE, seq: 14, type: 'tool_use', payload: { id: 'toolu_p52_live', name: 'Read', input: { file_path: '/tmp/p52/live.png' } } },
    { ...LIVE, seq: 15, type: 'tool_result', payload: { toolUseId: 'toolu_p52_live', content: [imageBlock(P52_IMAGES.markdown)] } },
    { ...LIVE, seq: 16, type: 'text_delta', payload: { text: ' and the one it took.' } },
  ],
  end: [
    { ...LIVE, seq: 17, type: 'assistant', payload: { text: 'Looking at the screenshot and the one it took: both match.' } },
    { ...LIVE, seq: 18, type: 'turn_end', payload: {} },
  ],
};

/** Hand frames to the conversation's open event stream (session-fixtures.mjs's idle EventSource). */
export async function p52Stream(page, frames) {
  await page.waitForFunction((path) => window.__uiMigrationStreams?.some((stream) => stream.readyState === 1 && new URL(stream.url).pathname === `/api${path}/events`), SESSION_PATH);
  await page.evaluate(({ path, frames }) => {
    const stream = window.__uiMigrationStreams.findLast((entry) => entry.readyState === 1 && new URL(entry.url).pathname === `/api${path}/events`);
    for (const frame of frames) stream.emit(frame);
  }, { path: SESSION_PATH, frames });
}

const FULL = { 9: { ...P52_EVENTS[8], truncated: false, payload: { ...P52_EVENTS[8].payload, content: [imageBlock(P52_IMAGES.clipped)] } } };

const BYTES = {
  [P52_IDS.userWide]: P52_IMAGES.userWide, [P52_IDS.userTall]: P52_IMAGES.userTall, [P52_IDS.markdown]: P52_IMAGES.markdown,
  [P52_IDS.later]: P52_IMAGES.later, [P52_IDS.putBack]: P52_IMAGES.putBack,
};
const ARTIFACT_BYTES = { [P52_ARTIFACTS.mock]: P52_IMAGES.artifact };

export function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

/** Count the object URLs the page makes and revokes, by URL, with what each was made from. */
export async function installObjectUrlLog(page) {
  await page.addInitScript(() => {
    const log = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      log.created.push({ url, type: object?.type ?? null, size: object?.size ?? null });
      return url;
    };
    URL.revokeObjectURL = (url) => {
      log.revoked.push(url);
      return revoke(url);
    };
    window.__p52ObjectUrls = log;
  });
}

export async function installP52Fixtures(page) {
  // `holdAttachments` keeps every attachment read open until released, so the loading state can be seen.
  const state = { holdAttachments: null, holdFull: null };
  const requests = [];
  const png = (route, bytes) => route.fulfill({ status: 200, contentType: 'image/png', body: bytes });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    const note = () => requests.push({ method, path, query: searchParams.toString() || undefined, authorization: request.headers().authorization ? 'Bearer' : null });
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (method !== 'GET') return route.fallback();

    // The owner's routes: the transcript, the attachment bytes (bearer-guarded), the session's artifacts, a clipped
    // event's whole payload.
    if (path === `/api${SESSION_PATH}/events/page`) return json({ events: P52_EVENTS, hasMore: false });
    const attachmentId = /^\/api\/attachments\/([^/]+)$/.exec(path)?.[1];
    if (attachmentId) {
      note();
      if (state.holdAttachments) await state.holdAttachments.promise;
      const bytes = BYTES[decodeURIComponent(attachmentId)];
      return bytes ? png(route, bytes) : json({ message: 'Attachment not found' }, 404);
    }
    if (path === `/api${SESSION_PATH}/artifacts`) {
      note();
      const bytes = ARTIFACT_BYTES[searchParams.get('path')];
      return bytes ? png(route, bytes) : json({ message: 'The runner that held this file is offline' }, 502);
    }
    const full = new RegExp(`^/api${SESSION_PATH}/events/(\\d+)/full$`).exec(path)?.[1];
    if (full) {
      note();
      if (state.holdFull) await state.holdFull.promise;
      return FULL[full] ? json(FULL[full]) : json({ message: 'Event not found' }, 404);
    }

    // The same conversation shared by a session link: header and events, then the bytes through the public routes.
    const shared = `/api/shared/${P52_TOKEN}`;
    if (path === shared) {
      note();
      return json({ kind: 'SESSION', title: SESSION.title, workspaceName: SESSION.workspace.name, status: 'SUCCEEDED', runState: 'SUCCEEDED',
        lifecycleState: 'COMPLETED', createdAt: SESSION.createdAt, events: P52_EVENTS, hasMore: false });
    }
    const sharedAttachment = new RegExp(`^${shared}/attachments/([^/]+)$`).exec(path)?.[1];
    if (sharedAttachment) {
      note();
      if (state.holdAttachments) await state.holdAttachments.promise;
      const bytes = BYTES[decodeURIComponent(sharedAttachment)];
      return bytes ? png(route, bytes) : json({ message: 'Attachment not found' }, 404);
    }
    if (path === `${shared}/artifacts`) {
      note();
      const bytes = ARTIFACT_BYTES[searchParams.get('path')];
      return bytes ? png(route, bytes) : json({ message: 'The runner that held this file is offline' }, 502);
    }
    const sharedFull = new RegExp(`^${shared}/events/(\\d+)$`).exec(path)?.[1];
    if (sharedFull) {
      note();
      return FULL[sharedFull] ? json(FULL[sharedFull]) : json({ message: 'Event not found' }, 404);
    }
    return route.fallback();
  });
  return { state, requests };
}
