import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UnprocessableEntityException } from '@nestjs/common';
import { MAX_UPLOAD_BYTES } from '../attachments/attachments.media';
import { CREDENTIAL_SAMPLES, ORDINARY_LINES, issued, survivingPiece } from './file-secret-samples.spec';
import { FILE_HOLDS_SECRET, SCAN_OVERLAP_BYTES, SCAN_READ_BYTES, findCredentialInFile, refuseCredentialIn } from './file-secret-scan';

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-secret-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scan(dir: string, content: string | Buffer) {
  const file = path.join(dir, 'upload');
  writeFileSync(file, content);
  return findCredentialInFile(file);
}

for (const { kind, shape, text } of CREDENTIAL_SAMPLES) {
  test(`finds ${shape} as ${kind}, and says which line it starts on`, async (t) => {
    const log = `first line\nsecond line\nthe value was ${text}\nlast line\n`;
    assert.deepEqual(await scan(scratch(t), log), { kind, line: 3 });
  });
}

test('the line is right in a file with no line break, in CRLF, and past the first read', async (t) => {
  const dir = scratch(t);
  const key = issued('ghp_', 36);
  assert.equal((await scan(dir, key))?.line, 1);
  assert.equal((await scan(dir, `one\r\ntwo\r\n${key}\r\n`))?.line, 3);
  const lines = 40_000;
  const log = 'a log line of about forty characters ok\n'.repeat(lines);
  assert.ok(log.length > 3 * SCAN_READ_BYTES, 'past the first reads');
  assert.equal((await scan(dir, `${log}${key}\n`))?.line, lines + 1);
});

for (const [what, line] of ORDINARY_LINES) {
  test(`leaves ${what} alone`, async (t) => {
    assert.equal(await scan(scratch(t), `before\n${line}\nafter\n`), null);
  });
}

test('an ordinary test log passes whole', async (t) => {
  const log = ORDINARY_LINES.map(([, line]) => line).join('\n');
  assert.equal(await scan(scratch(t), log.repeat(2000)), null);
});

test('a binary file is not read for credentials, whatever it holds', async (t) => {
  const dir = scratch(t);
  const key = Buffer.from(`the key ${issued('ghp_', 36)} `);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), key, Buffer.alloc(16)]);
  assert.equal(await scan(dir, png), null, 'a PNG with a key in a text chunk');
  assert.equal(await scan(dir, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), key])), null, 'a gzip header');
  assert.equal(await scan(dir, Buffer.concat([key, Buffer.alloc(1), key])), null, 'a NUL anywhere in the first 8000 bytes');
  assert.equal(await scan(dir, Buffer.concat([Buffer.alloc(7999, 0x20), Buffer.alloc(1), key])), null, 'its last byte');
});

test('a NUL past the first 8000 bytes leaves a text file a text file', async (t) => {
  const key = Buffer.from(issued('ghp_', 36));
  const log = Buffer.concat([Buffer.alloc(8000, 0x20), Buffer.alloc(1), Buffer.from('\n'), key]);
  assert.equal((await scan(scratch(t), log))?.kind, 'a GitHub token');
});

test('text in another encoding of ASCII is still read, and a character cut by a read does no harm', async (t) => {
  const dir = scratch(t);
  const key = issued('ghp_', 36);
  assert.equal((await scan(dir, `﻿日志：${key}`))?.kind, 'a GitHub token', 'UTF-8 with a BOM, and a word beside the key');
  // A three-byte character on each side of the read's edge, so that a read cuts one.
  const edge = '日'.repeat(Math.ceil(SCAN_READ_BYTES / 3) + 1);
  assert.equal((await scan(dir, `${edge} ${key}`))?.kind, 'a GitHub token');
});

test('a credential is seen wherever the reads cut it, up to the longest a shape needs to be seen whole', async (t) => {
  const dir = scratch(t);
  const line = 'an ordinary line of a test log\n';
  const filler = (length: number) => line.repeat(Math.ceil(length / line.length)).slice(0, length);
  const header = `eyJ${issued('', 20_000, 'aB3dE9xY')}`;
  const payload = `eyJ${issued('', SCAN_OVERLAP_BYTES - 21_000, 'pQ7rS2tU')}`;
  const long = `${header}.${payload}.${issued('', 43, 'k3Jp_Xq9-Wm2Zt7B')}`;
  assert.ok(`${header}.${payload}.`.length < SCAN_OVERLAP_BYTES, 'all of what the shape needs fits in the overlap');
  for (const [kind, credential] of [['a GitHub token', issued('ghp_', 36)], ['a JSON web token', long]] as const) {
    for (const read of [1, 2, 3]) {
      const edge = read * SCAN_READ_BYTES - (read - 1) * SCAN_OVERLAP_BYTES;
      for (const cut of [0, 1, 2, 3, 4, 19, 20, 35, 36, Math.floor(credential.length / 2), credential.length - 1]) {
        const content = `${filler(edge - cut - 1)} ${credential}\n${filler(1024)}`;
        assert.equal((await scan(dir, content))?.kind, kind, `read ${read}, ${cut} characters over its edge`);
      }
    }
  }
});

test('a 25 MiB text file is read a piece at a time, in one buffer, to its last line', async (t) => {
  const file = path.join(scratch(t), 'big.log');
  const line = Buffer.from('2026-11-02T08:31:38Z ok - password=xxx token=abc\n');
  const block = Buffer.concat(new Array<Buffer>(Math.floor(65_536 / line.length)).fill(line));
  const key = `the key ${issued('ghp_', 36)}\n`;
  const fd = openSync(file, 'w');
  let size = 0;
  let lines = 0;
  while (size + block.length + key.length <= MAX_UPLOAD_BYTES) {
    size += writeSync(fd, block);
    lines += block.length / line.length;
  }
  size += writeSync(fd, key);
  closeSync(fd);
  assert.ok(size > MAX_UPLOAD_BYTES - block.length, `${size} bytes`);

  const realExec = RegExp.prototype.exec;
  let longest = 0;
  const before = process.memoryUsage().arrayBuffers;
  let highest = before;
  const exec = t.mock.method(RegExp.prototype, 'exec', function exec(this: RegExp, text: string) {
    longest = Math.max(longest, text.length);
    highest = Math.max(highest, process.memoryUsage().arrayBuffers);
    return realExec.call(this, text);
  });
  const found = await findCredentialInFile(file);
  const matched = exec.mock.callCount();
  exec.mock.restore();

  assert.deepEqual(found, { kind: 'a GitHub token', line: lines + 1 }, 'found at the very end of the file');
  assert.ok(matched > 2 * Math.floor(size / SCAN_READ_BYTES), `the spy saw ${matched} matches, so these numbers measure the scan`);
  const window = SCAN_READ_BYTES + SCAN_OVERLAP_BYTES;
  assert.ok(longest <= window, `a shape was matched against ${longest} characters at once, not the ${window} of one window`);
  assert.ok(highest - before <= 2 * window, `buffers grew ${highest - before} bytes while ${size} bytes were read`);
});

/**
 * Text built to make a shape backtrack. A shape with one repetition nested in another took more than nine minutes over
 * the first of these, on the event loop, and nothing can interrupt a running regular expression.
 */
const CRAFTED: ReadonlyArray<readonly [what: string, block: string]> = [
  ['spaces and header lookalikes after BEGIN lines', `-----BEGIN PRIVATE KEY-----${' '.repeat(5000)}x: y`],
  ['header lookalikes in one long line', `-----BEGIN PRIVATE KEY-----\nx: ${'y: z '.repeat(1000)}`],
  ['one long header value of spaces', `-----BEGIN PRIVATE KEY-----\nx: ${' '.repeat(70_000)}`],
  ['line breaks after BEGIN lines', `-----BEGIN PRIVATE KEY-----${'\n'.repeat(5000)}`],
  ['escaped line breaks after BEGIN lines', `-----BEGIN PRIVATE KEY-----${'\\n'.repeat(5000)}`],
  ['backslashes after BEGIN lines', `-----BEGIN PRIVATE KEY-----${'\\'.repeat(5000)}`],
  ['bare BEGIN lines', '-----BEGIN PRIVATE KEY-----\n'],
  ['almost a label', `-----BEGIN ${'A'.repeat(39)} `],
  ['one run with no dot after eyJ', `eyJ${'a'.repeat(70_000)}`],
  ['runs of eyJ-', 'eyJ-'],
  ['two parts and no third', `eyJ${'a'.repeat(5000)}.${'b'.repeat(5000)} `],
  ['runs of sk-', 'sk-'],
  ['almost long enough after sk-ant-', `sk-ant-${'a'.repeat(31)} `],
  ['almost long enough after sk-', `sk-${'a'.repeat(31)} `],
  ['runs of xoxb-', 'xoxb- '],
  ['one run of word characters', 'a'],
  ['all spaces', ' '],
];

test('crafted text costs about what a log costs: no shape backtracks over it', async (t) => {
  const dir = scratch(t);
  for (const [what, block] of CRAFTED) {
    const started = Date.now();
    const found = await scan(dir, block.repeat(Math.ceil(2 * SCAN_READ_BYTES / block.length)));
    assert.equal(found, null, what);
    assert.ok(Date.now() - started < 5_000, `${what} took ${Date.now() - started} ms over two reads of text`);
  }
});

test('a refusal says the file, what it looks like and the line, and repeats no credential', async (t) => {
  const dir = scratch(t);
  for (const { kind, shape, text, secret } of CREDENTIAL_SAMPLES) {
    const file = path.join(dir, 'upload');
    writeFileSync(file, `one\ntwo\n${text}\n`);
    const refused = await refuseCredentialIn({ path: file, originalname: 'report.log' }).then(
      () => assert.fail(`${shape} was not refused`),
      (error: unknown) => error as UnprocessableEntityException,
    );
    assert.ok(refused instanceof UnprocessableEntityException);
    const body = refused.getResponse() as { code: string; message: string };
    assert.equal(body.code, FILE_HOLDS_SECRET);
    assert.ok(body.message.startsWith(`report.log holds what looks like ${kind} on line 3,`), body.message);
    for (const piece of secret) assert.equal(survivingPiece(JSON.stringify(body), piece), undefined, `${shape} leaked: ${body.message}`);
  }
});

test('a file with nothing to refuse is let through', async (t) => {
  const file = path.join(scratch(t), 'upload');
  writeFileSync(file, 'password=xxx\ntoken=abc\n');
  await refuseCredentialIn({ path: file, originalname: 'test.log' });
});
