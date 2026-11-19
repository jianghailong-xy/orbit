import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { holdViewerStreamSlot, VIEWER_STREAM_CAPS, ViewerStreamCaps, viewerStreamsMax } from './viewer-stream-caps';

const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof HttpException && e.getStatus() === 429);

test('the design\'s caps: 4 per visitor on a link, 200 per link, 2000 in all unless VIEWER_STREAMS_MAX says otherwise', () => {
  assert.deepEqual(VIEWER_STREAM_CAPS, { perVisitor: 4, perLink: 200, total: 2000 });
  assert.equal(viewerStreamsMax(undefined), 2000);
  assert.equal(viewerStreamsMax(''), 2000);
  assert.equal(viewerStreamsMax(' 50 '), 50);
  for (const bad of ['0', '-1', '1.5', 'many']) assert.throws(() => viewerStreamsMax(bad), /VIEWER_STREAMS_MAX/);
});

test('each cap refuses at cap + 1 without taking a slot, and a release frees exactly one, once', () => {
  const caps = new ViewerStreamCaps({ perVisitor: 2, perLink: 3, total: 4 });
  const a1 = caps.open({ visitor: 'v a', link: 'a' });
  caps.open({ visitor: 'v a', link: 'a' });
  refused(() => caps.open({ visitor: 'v a', link: 'a' }));
  caps.open({ visitor: 'w a', link: 'a' });
  refused(() => caps.open({ visitor: 'x a', link: 'a' }));
  caps.open();
  refused(() => caps.open({ visitor: 'y b', link: 'b' }));
  refused(() => caps.open());
  assert.equal(caps.held, 4);
  a1();
  a1();
  assert.equal(caps.held, 3);
  caps.open({ visitor: 'v a', link: 'a' });
  assert.equal(caps.held, 4);
});

test('a held slot is given back when the answer closes, or at once when it already has', () => {
  const caps = new ViewerStreamCaps({ perVisitor: 4, perLink: 200, total: 1 });
  const res = new EventEmitter();
  holdViewerStreamSlot(caps, res);
  assert.equal(caps.held, 1);
  res.emit('close');
  assert.equal(caps.held, 0);
  holdViewerStreamSlot(caps, Object.assign(new EventEmitter(), { closed: true }));
  assert.equal(caps.held, 0);
});
