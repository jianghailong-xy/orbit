// What a link address answers an upgrade request that carries no token, printed as one line: the status and the body's
// code, or `unreachable <why>`. Run in the apiserver's image, on this project's network, by /upgrade's script and
// scripts/install-server.sh, which have node there and need neither curl nor node on the host:
//
//   docker compose run --rm --no-deps -T apiserver node - <url> < scripts/runner-link/door-check.js
//
// `401 UNAUTHENTICATED` is the link gateway itself refusing the missing token, so the way to it carries upgrades. A 426
// from the link gateway means something between here and it dropped the Upgrade header; anything else, that the address
// is not the link gateway at all. Nothing is logged or kept, and no token is sent.
'use strict';

const target = new URL(process.argv[2]);
const client = require(target.protocol === 'https:' ? 'node:https' : 'node:http');

const say = (line) => {
  console.log(line);
  process.exit(0);
};

const request = client.request(target, {
  method: 'GET',
  timeout: 10_000,
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': Buffer.from('orbit link door 1').toString('base64'),
  },
});
request.on('timeout', () => request.destroy(new Error('no answer within 10 s')));
request.on('error', (error) => say(`unreachable ${error.code ?? error.message}`));
// A switch to a WebSocket with no token would be a gateway that lets anyone in: not the answer this asks for.
request.on('upgrade', () => say('101 UPGRADED'));
request.on('response', (response) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    if (body.length < 4096) body += chunk;
  });
  response.on('end', () => {
    let code = '';
    try {
      code = JSON.parse(body).code ?? '';
    } catch {
      // Not the link gateway's JSON: the status says it.
    }
    say(`${response.statusCode}${code ? ` ${code}` : ''}`);
  });
});
request.end();
