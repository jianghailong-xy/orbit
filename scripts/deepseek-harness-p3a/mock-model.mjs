// P3a's synthetic Messages endpoint. The caller runs the unmodified official dsh CLI.
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [log, writtenFile] = process.argv.slice(2);
assert.ok(log && writtenFile, 'usage: mock-model.mjs <request-log> <written-file>');
writeFileSync(log, '');
let calls = 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/messages');
      assert.equal(req.headers['x-api-key'], 'sk-p3a-synthetic');
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
      return;
    }
    appendFileSync(log, JSON.stringify({ call: ++calls, url: req.url, body }) + '\n');
    if (calls > 3) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unexpected extra model request' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [{ type: 'message_start', message: { id: `msg_p3a_${calls}`, type: 'message', role: 'assistant', model: body.model,
      content: [], usage: { input_tokens: 32, output_tokens: 0 } } }];
    if (calls === 1) {
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'P3A committed reasoning' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
      for (const text of ['P3A first ', 'committed ', 'answer']) {
        events.push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } });
      }
      events.push({ type: 'content_block_stop', index: 1 });
    } else if (calls === 2) {
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_p3a_write', name: 'write', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: writtenFile, content: 'P3A real dsh tool effect' }) } },
        { type: 'content_block_stop', index: 0 });
    } else {
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'P3A second answer after native write' } },
        { type: 'content_block_stop', index: 0 });
    }
    events.push({ type: 'message_delta', delta: { stop_reason: calls === 2 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' });
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}\n`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
