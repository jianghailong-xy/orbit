// P3b's synthetic Messages endpoint for the unmodified official dsh CLI. Each call is scripted:
// 1 answer, 2 hold until the client cancels, 3 answer, 4 native write tool, 5 hold (the runner
// loses its lease here), 6 answer. Any further request is an unexpected replay and fails.
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [log, writtenFile] = process.argv.slice(2);
assert.ok(log && writtenFile, 'usage: mock-model.mjs <request-log> <written-file>');
writeFileSync(log, '');
let calls = 0;
const send = (res, events) => { for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`); };
const text = (call, model, body) => [
  { type: 'message_start', message: { id: `msg_p3b_${call}`, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 32, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: body } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
  { type: 'message_stop' },
];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/messages');
      assert.equal(req.headers['x-api-key'], 'sk-p3b-synthetic');
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
      return;
    }
    const call = ++calls;
    appendFileSync(log, JSON.stringify({ call, url: req.url, body }) + '\n');
    if (call > 6) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unexpected extra model request' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (call === 2 || call === 5) {
      // Stream a started answer and never finish it; the connection stays open until the client goes.
      send(res, text(call, body.model, 'P3B partial').slice(0, 3));
      return;
    }
    if (call === 4) {
      send(res, [
        { type: 'message_start', message: { id: 'msg_p3b_4', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 32, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_p3b_write', name: 'write', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: writtenFile, content: 'P3B real dsh tool effect' }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ]);
      res.end();
      return;
    }
    send(res, text(call, body.model, { 1: 'P3B first answer', 3: 'P3B third answer', 6: 'P3B final answer' }[call]));
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}\n`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
