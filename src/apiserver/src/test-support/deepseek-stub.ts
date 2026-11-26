import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** One chat call the stub was sent: its bearer and its body. */
export interface DeepSeekStubCall {
  authorization: string | undefined;
  body: { model?: string; messages?: Array<{ role: string; content: string }> } & Record<string, unknown>;
}

/**
 * A stand-in for DeepSeek's `POST /chat/completions` on 127.0.0.1, for a spawned apiserver's DEEPSEEK_BASE_URL. Each
 * call is recorded; `reply` decides the answer — a string is the assistant's content, a number an HTTP status — and
 * may take its time.
 */
export async function startDeepSeekStub(reply: (call: DeepSeekStubCall) => string | number | Promise<string | number>) {
  const calls: DeepSeekStubCall[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', async () => {
      const call: DeepSeekStubCall = { authorization: req.headers.authorization, body: JSON.parse(raw || '{}') };
      calls.push(call);
      const answer = req.url === '/chat/completions' ? await reply(call) : 404;
      if (typeof answer === 'number') {
        res.writeHead(answer, { 'content-type': 'application/json' }).end('{"error":"stub"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
