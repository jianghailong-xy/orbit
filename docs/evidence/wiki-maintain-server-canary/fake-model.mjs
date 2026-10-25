// The fake System model of the P8 maintenance canary: an Anthropic-Messages endpoint that answers an
// extraction with one pitfall citing the dossier's own turn line, and anything else with a verdict.
//
//   node fake-model.mjs <port> <hits.jsonl>
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 8815);
const hits = process.argv[3] ?? '/tmp/p8maint/hits.jsonl';
const MODEL = process.env.MODEL ?? 'p8-maintain-system-model';
let calls = 0;

/** The words the seeded turns all carry, and the answer's quote. */
const QUOTE = 'connect ECONNREFUSED 127.0.0.1:9000';
/** A path this branch's checkout has at the snapshot's commit: the entry's anchor. */
const ANCHOR = 'src/apiserver/src/wiki/wiki-maintenance-run.ts';

function extraction(prompt) {
  // The dossier's own turn line, as the server wrote it: `L7 owner: … connect ECONNREFUSED …`. The prompt's own
  // EXAMPLE above the case file carries a line like it, so only the case file is read.
  const dossier = prompt.slice(prompt.indexOf('==== CASE FILE ===='));
  const line = /^(L\d+) [a-z-]+: .*connect ECONNREFUSED.*$/mu.exec(dossier);
  if (!line) return '[]';
  calls += 1;
  return JSON.stringify([{
    kind: 'pitfall',
    title: `导入时读取端口会让 fixture 失效 ${line[1]}-${calls}`,
    summary: 'PORT 必须在 import 之前设好，否则 fixture 之后再设没有用。',
    topic: 'testing',
    trigger: { paths: [ANCHOR], commands: ['go test ./...'], errorSignature: 'connect ECONNREFUSED' },
    symptom: '测试报 connect ECONNREFUSED 127.0.0.1:9000',
    cause: '模块导入时读取 PORT，fixture 设置得太晚',
    fix: 'fixture 返回 url，测试从返回值取地址',
    anchors: { paths: [ANCHOR], commits: [] },
    sources: [{ ref: line[1], quote: QUOTE }],
    verified: true,
  }]);
}

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk.toString(); });
  request.on('end', () => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
      return;
    }
    let prompt = '';
    try {
      const parsed = JSON.parse(body);
      prompt = parsed.messages?.[0]?.content ?? '';
    } catch { /* an unreadable body is answered as an extraction of nothing */ }
    const answer = prompt.includes('==== CASE FILE ====')
      ? extraction(prompt)
      : '{"verdict":"supported","reason":"the cited turn says exactly this"}';
    appendFileSync(hits, `${JSON.stringify({ at: new Date().toISOString(), dossier: prompt.includes('==== CASE FILE ===='), prompt: prompt.slice(0, 200) })}\n`);
    const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 10, output_tokens: 1 } } }));
    response.write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }));
    response.write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }));
    response.write(event('message_stop', { type: 'message_stop' }));
    response.end();
  });
});
server.listen(port, '127.0.0.1', () => console.log(`fake System model ${MODEL} on 127.0.0.1:${port}`));
