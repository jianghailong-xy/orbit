/**
 * For a spec that runs the production apiserver as a child process (auth/pat-test-apiserver.ts) and needs GitHub to
 * answer it: importing this preloads itself into every apiserver the spec spawns with its environment, and in such a
 * process sends each call to github.com and api.github.com to the fake GitHub the spec serves (serveFakeGithub) and
 * names in ORBIT_TEST_FAKE_GITHUB. Everything else goes where it was going.
 *
 * Production has no such thing: the apiserver's GitHub addresses are fixed (github/github-api.client.ts), and nothing
 * but this preload, loaded only by a spec, puts another answer in their place.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeGithub } from './fake-github';

const ORIGINS: Record<string, string> = { 'https://github.com': 'web', 'https://api.github.com': 'api' };
const BACK: Record<string, string> = { web: 'https://github.com', api: 'https://api.github.com' };

const target = process.env.ORBIT_TEST_FAKE_GITHUB;
if (target) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const tag = ORIGINS[url.origin];
    if (!tag) return real(input, init);
    return real(`${target}/${tag}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

const preload = `--require ${__filename}`;
if (!process.env.NODE_OPTIONS?.includes(preload)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
}

/** Serve `fake` over HTTP on 127.0.0.1 and name it in ORBIT_TEST_FAKE_GITHUB for the apiservers spawned after. */
export async function serveFakeGithub(fake: FakeGithub): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const [, tag, ...rest] = (req.url ?? '/').split('/');
      const origin = BACK[tag ?? ''];
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const body = parts.length > 0 ? Buffer.concat(parts).toString('utf8') : undefined;
      Promise.resolve()
        .then(() => {
          if (!origin) throw new Error(`not a GitHub origin: ${req.url}`);
          return fake.fetch(`${origin}/${rest.join('/')}`, { method: req.method, headers, body });
        })
        .then(async (answer) => {
          res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
          res.end(answer.status === 204 ? undefined : await answer.text());
        })
        .catch((error: unknown) => {
          res.writeHead(599, { 'content-type': 'text/plain' });
          res.end(String(error));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ORBIT_TEST_FAKE_GITHUB = url;
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
