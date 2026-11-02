// Captures, at a local stub endpoint, the exact bytes the wiki-worker's client POSTs to {base}/v1/messages for one
// value of ORBIT_WIKI_MODEL_THINKING, or for none: the environment is read by readWikiSystemModel and the call made by
// askWikiSystemModel, both from the apiserver build named. No real model is called: the base URL is a 127.0.0.1 port
// this script listens on, and the key is a placeholder.
//
//   node capture-body.cjs <src/apiserver/build> [<ORBIT_WIKI_MODEL_THINKING value>]
//
// Prints the body as the stub received it, then its sha256. Run against the build of the commit before the switch
// (whose reader and client know nothing of it) and against the build after it, the unset bodies must be the same bytes.
'use strict';
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');

const [buildDir, ...rest] = process.argv.slice(2);
const setting = rest.length > 0 ? rest[0] : undefined;
const { askWikiSystemModel } = require(path.resolve(buildDir, 'wiki-worker/wiki-model-client.js'));
const { readWikiSystemModel } = require(path.resolve(buildDir, 'wiki-worker/wiki-system-model.js'));

const sse = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

async function main() {
  let body = null;
  const server = http.createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      text += chunk;
    });
    request.on('end', () => {
      body = text;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        sse('message_start', { message: { model: 'stub', usage: { input_tokens: 1, output_tokens: 1 } } }),
        sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
        sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
        sse('message_stop'),
      ].join(''));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = {
      ORBIT_WIKI_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ORBIT_WIKI_MODEL_API_KEY: 'sk-placeholder-not-a-key',
      ORBIT_WIKI_MODEL: 'deepseek-v4-pro',
    };
    if (setting !== undefined) env.ORBIT_WIKI_MODEL_THINKING = setting;
    const config = readWikiSystemModel(env);
    // The endpoint as the request queue builds it (wiki-model-queue.service.ts, endpoint()); a build from before the
    // switch has no `thinking` in its configuration, and its client sends no such field whatever the endpoint holds.
    const endpoint = { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, thinking: config.thinking };
    const answer = await askWikiSystemModel(endpoint, {
      system: 'You extract wiki entries.',
      prompt: 'The dossier.',
      maxTokens: 1024,
      timeoutMs: 5_000,
    });
    if (answer.text !== 'ok') throw new Error(`the stub's answer read as ${JSON.stringify(answer.text)}`);
    process.stdout.write(`${body}\n`);
    process.stdout.write(`sha256 ${createHash('sha256').update(body, 'utf8').digest('hex')}\n`);
    for (const problem of config.problems) process.stdout.write(`problem ${problem}\n`);
  } finally {
    server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
