#!/usr/bin/env node
// A scripted viewer of the managed runner browser (docs/runner-browser-design.md §4): opens the viewer route's WebSocket,
// GET /api/runners/:id/browser/vnc, completes the RFB 3.8 handshake with x11vnc on the runner (security None), asks for
// the whole screen and then for UPDATES incremental updates, and prints what it got as one JSON object. With --ppm, the
// first full framebuffer is written there as a PPM picture. With --keys, before it asks for the screen it types into
// the browser as the owner would in the viewer: a `|`-separated list of `type:TEXT` (each character as its keysym),
// a key name (Return, Tab, Escape, BackSpace), `ctrl+X`, or `wait:MS`. The access token is read from the environment
// and never printed.
//
//   ORBIT_ACCESS_TOKEN=... node vnc-client.mjs ws://127.0.0.1:13718 <runnerId> [--updates N] [--ppm out.ppm] [--keys SPEC]
import { writeFileSync } from 'node:fs';

const [base, runnerId, ...rest] = process.argv.slice(2);
if (!base || !runnerId || !process.env.ORBIT_ACCESS_TOKEN) {
  console.error('usage: ORBIT_ACCESS_TOKEN=... vnc-client.mjs ws://host:port <runnerId> [--updates N] [--ppm out.ppm]');
  process.exit(2);
}
const option = (name, fallback) => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : fallback;
};
const updates = Number(option('--updates', '3'));
const ppm = option('--ppm', '');
const keys = option('--keys', '');
const url = `${base.replace(/\/$/, '')}/api/runners/${encodeURIComponent(runnerId)}/browser/vnc`;

const began = Date.now();
const ms = () => Date.now() - began;
const report = { route: url, steps: [] };
const step = (what, detail = {}) => report.steps.push({ at: ms(), what, ...detail });

const ws = new WebSocket(`${url}?access_token=${encodeURIComponent(process.env.ORBIT_ACCESS_TOKEN)}`);
ws.binaryType = 'arraybuffer';
let buffered = Buffer.alloc(0);
let wake = () => undefined;
let closed = null;
ws.addEventListener('message', (event) => {
  buffered = Buffer.concat([buffered, Buffer.from(event.data)]);
  wake();
});
ws.addEventListener('close', (event) => {
  closed = { code: event.code, reason: event.reason };
  wake();
});
const opened = new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('the WebSocket did not open (refused, or the route is absent)')), { once: true });
});

async function read(n) {
  const deadline = Date.now() + 30_000;
  while (buffered.length < n) {
    if (closed) throw new Error(`the stream closed: ${closed.code} ${closed.reason}`);
    if (Date.now() > deadline) throw new Error(`waited 30 s for ${n} bytes, have ${buffered.length}`);
    await new Promise((resolve) => {
      wake = resolve;
      setTimeout(resolve, 1_000);
    });
  }
  const out = buffered.subarray(0, n);
  buffered = buffered.subarray(n);
  return out;
}
const send = (bytes) => ws.send(Uint8Array.from(bytes));
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];

try {
  await opened;
  step('websocket open');
  const version = (await read(12)).toString('latin1');
  step('server version', { version: version.trim() });
  if (!/^RFB 003\.00[38]\n$/.test(version)) throw new Error(`not an RFB server: ${JSON.stringify(version)}`);
  send(Buffer.from('RFB 003.008\n'));
  const count = (await read(1))[0];
  if (count === 0) {
    const length = (await read(4)).readUInt32BE(0);
    throw new Error(`the server refused: ${(await read(length)).toString('utf8')}`);
  }
  const types = [...(await read(count))];
  step('security types', { types });
  if (!types.includes(1)) throw new Error('the server offers no security type None');
  send([1]);
  const result = (await read(4)).readUInt32BE(0);
  step('security result', { result });
  if (result !== 0) throw new Error(`security failed: ${result}`);
  send([1]); // ClientInit, shared
  const init = await read(24);
  const width = init.readUInt16BE(0);
  const height = init.readUInt16BE(2);
  const pf = {
    bitsPerPixel: init[4], depth: init[5], bigEndian: init[6], trueColour: init[7],
    redMax: init.readUInt16BE(8), greenMax: init.readUInt16BE(10), blueMax: init.readUInt16BE(12),
    redShift: init[14], greenShift: init[15], blueShift: init[16],
  };
  const name = (await read(init.readUInt32BE(20))).toString('utf8');
  step('server init', { width, height, pixelFormat: pf, name });
  report.handshake = 'complete';
  if (keys) {
    const KEYSYMS = { Return: 0xff0d, Tab: 0xff09, Escape: 0xff1b, BackSpace: 0xff08 };
    const key = (sym, down) => send([4, down ? 1 : 0, 0, 0, (sym >>> 24) & 0xff, (sym >> 16) & 0xff, (sym >> 8) & 0xff, sym & 0xff]);
    const tap = async (sym) => {
      key(sym, true);
      key(sym, false);
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    for (const item of keys.split('|')) {
      if (item.startsWith('wait:')) await new Promise((resolve) => setTimeout(resolve, Number(item.slice(5))));
      else if (item.startsWith('type:')) for (const ch of item.slice(5)) await tap(ch.codePointAt(0));
      else if (item.startsWith('ctrl+')) {
        key(0xffe3, true);
        await tap(item.slice(5).codePointAt(0));
        key(0xffe3, false);
      } else if (KEYSYMS[item]) await tap(KEYSYMS[item]);
      else throw new Error(`unknown key ${JSON.stringify(item)}`);
    }
    step('keys sent', { items: keys.split('|').length });
  }
  send([2, 0, ...u16(1), 0, 0, 0, 0]); // SetEncodings: Raw
  const bpp = pf.bitsPerPixel / 8;
  const frame = Buffer.alloc(width * height * bpp);
  report.updates = [];
  for (let i = 0; i <= updates; i += 1) {
    send([3, i === 0 ? 0 : 1, ...u16(0), ...u16(0), ...u16(width), ...u16(height)]); // FramebufferUpdateRequest
    const asked = ms();
    for (;;) {
      const type = (await read(1))[0];
      if (type === 0) {
        const header = await read(3);
        const rects = header.readUInt16BE(1);
        let bytes = 0;
        for (let r = 0; r < rects; r += 1) {
          const rect = await read(12);
          const [x, y, w, h] = [rect.readUInt16BE(0), rect.readUInt16BE(2), rect.readUInt16BE(4), rect.readUInt16BE(6)];
          const encoding = rect.readInt32BE(8);
          if (encoding !== 0) throw new Error(`unexpected encoding ${encoding}`);
          const pixels = await read(w * h * bpp);
          for (let row = 0; row < h; row += 1) {
            pixels.copy(frame, ((y + row) * width + x) * bpp, row * w * bpp, (row + 1) * w * bpp);
          }
          bytes += pixels.length;
        }
        report.updates.push({ request: i === 0 ? 'full' : 'incremental', rects, pixelBytes: bytes, ms: ms() - asked });
        break;
      } else if (type === 2) {
        continue; // Bell
      } else if (type === 3) {
        const length = (await read(7)).readUInt32BE(3);
        await read(length); // ServerCutText
      } else if (type === 1) {
        const header = await read(5);
        await read(header.readUInt16BE(3) * 6); // SetColourMapEntries
      } else {
        throw new Error(`unexpected server message ${type}`);
      }
    }
    if (i === 0 && ppm) {
      const rgb = Buffer.alloc(width * height * 3);
      for (let p = 0; p < width * height; p += 1) {
        const v = pf.bigEndian ? frame.readUIntBE(p * bpp, bpp) : frame.readUIntLE(p * bpp, bpp);
        rgb[p * 3] = Math.round((((v >> pf.redShift) & pf.redMax) * 255) / pf.redMax);
        rgb[p * 3 + 1] = Math.round((((v >> pf.greenShift) & pf.greenMax) * 255) / pf.greenMax);
        rgb[p * 3 + 2] = Math.round((((v >> pf.blueShift) & pf.blueMax) * 255) / pf.blueMax);
      }
      writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
      const distinct = new Set();
      for (let p = 0; p < rgb.length; p += 3 * 997) distinct.add(rgb.readUIntBE(p, 3));
      report.firstFrame = { file: ppm, sampledDistinctColours: distinct.size };
    }
  }
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
} finally {
  ws.close(1000, 'done');
  await new Promise((resolve) => setTimeout(resolve, 300));
  report.closed = closed;
  report.ms = ms();
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.ok ? 0 : 1);
}
