// D1's synthetic Messages endpoint for the pinned official dsh CLI that an Orbit runner launches.
// Every request it hears is appended to <request-log>; every accepted one gets one text answer.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [log, apiKey, answer] = process.argv.slice(2);
if (!log || !apiKey || !answer) throw new Error('usage: mock-model.mjs <request-log> <api-key> <answer>');
writeFileSync(log, '');
let calls = 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* recorded and refused below */ }
    const accepted = req.method === 'POST' && req.url === '/v1/messages' && req.headers['x-api-key'] === apiKey && body;
    appendFileSync(log, JSON.stringify({ call: ++calls, method: req.method, url: req.url, accepted: !!accepted, model: body?.model ?? null,
      keyMatched: req.headers['x-api-key'] === apiKey, lastUser: lastUserText(body) }) + '\n');
    if (!accepted) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'D1 mock refused this request' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: `msg_d1_${calls}`, type: 'message', role: 'assistant', model: body.model, content: [],
        usage: { input_tokens: 24, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});

function lastUserText(body) {
  const message = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'user');
  if (!message) return null;
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}\n`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
