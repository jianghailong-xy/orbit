import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { type CallHandler, type ExecutionContext, StreamableFile } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { streamable } from './files.service';
import { UserFileResponseInterceptor, attachmentDisposition, inlineType } from './user-file-response';

/** What the interceptor sets on the response when a route answers with `body`. */
async function headersFor(body: unknown): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const response = { setHeader: (name: string, value: string) => void (headers[name] = value) };
  const context = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(body) };
  assert.equal(await lastValueFrom(new UserFileResponseInterceptor().intercept(context, next)), body, 'the body passes through');
  return headers;
}

const file = (type: string, disposition?: string) => new StreamableFile(Buffer.from('bytes'), { type, disposition });

test('only raster pictures and PDFs may be shown', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/pdf']) {
    assert.equal(inlineType(type), type);
  }
  for (const type of [
    'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml', 'text/plain', 'application/json',
    'application/javascript', 'text/css', 'multipart/x-mixed-replace', 'application/octet-stream', 'image/', '', 'html',
  ]) {
    assert.equal(inlineType(type), null, type);
  }
});

test('a type is read the way a browser would: case and parameters aside, and never a list of types', () => {
  assert.equal(inlineType('IMAGE/PNG'), 'image/png');
  assert.equal(inlineType(' image/png ; name=shot.png'), 'image/png');
  assert.equal(inlineType('application/pdf;charset=binary'), 'application/pdf');
  assert.equal(inlineType('image/png, text/html'), null);
  assert.equal(inlineType('text/html;image/png'), null);
});

test('a file that may be shown stays inline, under its bare type, sandboxed and never sniffed', async () => {
  assert.deepEqual(await headersFor(file('IMAGE/PNG;,text/html', 'inline')), {
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'image/png',
  });
});

test('a type off the list is never answered inline, whatever the route asked for', async () => {
  for (const disposition of ['inline', undefined]) {
    assert.deepEqual(await headersFor(file('text/html', disposition)), {
      'Content-Security-Policy': 'sandbox',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment',
    });
  }
});

test('a type a browser could run as a script leaves as bytes, however it is written', async () => {
  for (const type of ['text/javascript', 'application/javascript', 'Text/ECMAScript; charset=utf-8', 'text/plain, text/jscript', 'text/livescript']) {
    assert.deepEqual(await headersFor(file(type)), {
      'Content-Security-Policy': 'sandbox',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
    }, type);
  }
});

test('a route that already saves the file keeps its own name for it', async () => {
  const saved = await headersFor(file('image/svg+xml', attachmentDisposition('drawing.svg')));
  assert.equal(saved['Content-Disposition'], undefined, 'nothing replaces the name the route gave');
  assert.equal(saved['Content-Security-Policy'], 'sandbox');
  assert.equal(saved['X-Content-Type-Options'], 'nosniff');
});

test('an answer that is not a file is left alone', async () => {
  assert.deepEqual(await headersFor({ id: 'x' }), {});
  assert.deepEqual(await headersFor(undefined), {});
});

test('a download route shows what may be shown and saves the rest under its own name', () => {
  const opened = (mimeType: string, fileName: string | null) =>
    streamable({ content: Buffer.from('bytes'), mimeType, fileName, sizeBytes: 5 }).getHeaders();
  assert.deepEqual(opened('image/png', 'shot.png'), { type: 'image/png', disposition: 'inline', length: 5 });
  assert.deepEqual(opened('application/pdf', 'spec.pdf'), { type: 'application/pdf', disposition: 'inline', length: 5 });
  assert.equal(opened('text/html', 'page.html').disposition, `attachment; filename="page.html"; filename*=UTF-8''page.html`);
  assert.equal(opened('image/svg+xml', null).disposition, `attachment; filename="attachment"; filename*=UTF-8''attachment`);
});

test('a stream from the store is still ended with the response', () => {
  const content = Readable.from(['bytes']);
  const closes: (() => void)[] = [];
  const response = { once: (_: string, close: () => void) => closes.push(close) };
  streamable({ content, mimeType: 'text/html', fileName: 'page.html', sizeBytes: 5 }, response as never);
  closes[0]();
  assert.equal(content.destroyed, true);
});

test('a saved name is safe in the header and readable as it was written', () => {
  assert.equal(
    attachmentDisposition('résumé "final".html'),
    `attachment; filename="r_sum_ _final_.html"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.html`,
  );
  assert.match(attachmentDisposition('a\r\nb'), /^attachment; filename="a__b"/);
  assert.match(attachmentDisposition(''), /^attachment; filename="download"/);
});
