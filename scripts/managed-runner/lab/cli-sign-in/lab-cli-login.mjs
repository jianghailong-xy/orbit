#!/usr/bin/env node
// A command-line tool that signs in through the browser with a localhost callback, as `gh auth login --web` or
// `gcloud auth login` do, for the lab (scenarios/browser_cli_sign_in.sh). It needs no real account: the provider is
// authorize.html, served by the lab.
//
//   node lab-cli-login.mjs browser|xdg PROVIDER_ORIGIN RESULT_FILE
//
// It listens on 127.0.0.1 on a free port, opens PROVIDER_ORIGIN/authorize.html?…&redirect_uri=http://127.0.0.1:PORT/
// callback&state=… through $BROWSER (browser) or `xdg-open` found on PATH (xdg), and waits for the callback. A callback
// with the right state and a code writes SIGNED-IN to RESULT_FILE and exits 0. It never prints the address it opens:
// its query carries the state, which the lab looks for in Orbit's logs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import http from 'node:http';

const [mode, provider, resultFile] = process.argv.slice(2);
if (!['browser', 'xdg'].includes(mode) || !provider || !resultFile) {
  console.error('usage: lab-cli-login.mjs browser|xdg PROVIDER_ORIGIN RESULT_FILE');
  process.exit(2);
}
const state = 'LABSTATE' + randomBytes(8).toString('hex');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const ok = url.searchParams.get('state') === state && /^LABCODE\w+$/.test(url.searchParams.get('code') ?? '');
  const title = ok ? 'Lab CLI: signed in' : 'Lab CLI: sign-in failed';
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${title}</title><body style="font:28px sans-serif;margin:60px;background:#e9f9ee">` +
    `<h1>${ok ? 'Signed in.' : 'Sign-in failed.'}</h1><p>The command-line tool on the runner received its localhost ` +
    'callback. You can close this tab.</p></body>');
  writeFileSync(resultFile, ok ? 'SIGNED-IN\n' : 'BAD-CALLBACK\n');
  console.log(ok ? 'lab-cli: signed in through the localhost callback' : 'lab-cli: a callback with the wrong state');
  setTimeout(() => process.exit(ok ? 0 : 1), 500);
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const target = `${provider}/authorize.html?client_id=orbit-lab&redirect_uri=` +
    encodeURIComponent(`http://127.0.0.1:${port}/callback`) + `&state=${state}&code_challenge=LABSECRET${randomBytes(6).toString('hex')}`;
  console.log(`lab-cli: waiting for the sign-in callback on 127.0.0.1:${port}`);
  const opener = mode === 'xdg' ? 'xdg-open' : process.env.BROWSER;
  if (!opener) {
    console.log('lab-cli: no BROWSER to open the sign-in page with');
    process.exit(2);
  }
  const child = spawn(opener, [target], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', (error) => console.log(`lab-cli: ${mode === 'xdg' ? 'xdg-open' : '$BROWSER'} did not start (${error.code})`));
  child.on('exit', (code) => console.log(`lab-cli: the opener exited ${code}`));
});
setTimeout(() => {
  console.log('lab-cli: no callback in time');
  process.exit(3);
}, 15 * 60 * 1000);
