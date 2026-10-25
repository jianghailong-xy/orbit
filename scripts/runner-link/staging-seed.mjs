#!/usr/bin/env node
// Seeds the runner link staging stack (staging-up.sh calls it): the deployment's first account, a runner registered to
// it for the test client, and an enrollment token for one more runner, the real one a drill registers. It keeps what
// still works: an account that exists is signed in to, and a runner token that still mints link tokens is reused.
// It writes the tokens into <state>/secrets and what a drill needs to find the stack into <state>/staging.json.
//
//   node scripts/runner-link/staging-seed.mjs <origin> <state dir> <metrics URL> <project>
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [origin, state, metricsUrl, project] = process.argv.slice(2);
if (!origin || !state || !metricsUrl || !project) {
  console.error('usage: staging-seed.mjs <origin> <state dir> <metrics URL> <project>');
  process.exit(2);
}
const secrets = path.join(state, 'secrets');
const secret = (name) => (existsSync(path.join(secrets, name)) ? readFileSync(path.join(secrets, name), 'utf8').trim() : '');
const keep = (name, value) => writeFileSync(path.join(secrets, name), `${value}\n`, { mode: 0o600 });

async function call(method, route, { token, body } = {}) {
  const res = await fetch(`${origin}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function must(result, what) {
  if (result.status < 200 || result.status >= 300) {
    console.error(`staging-seed: ${what} answered ${result.status}: ${JSON.stringify(result.json)}`);
    process.exit(1);
  }
  return result.json;
}

const email = 'owner@orbit-staging.test';
const password = secret('owner_password');
let signedIn = await call('POST', '/auth/bootstrap', { body: { email, name: 'Staging owner', password } });
if (signedIn.status >= 400) signedIn = await call('POST', '/auth/login', { body: { email, password } });
const { accessToken } = must(signedIn, 'signing in as the staging owner');

let runnerToken = secret('runner_token');
if (runnerToken && (await call('POST', '/runner/link-token', { token: runnerToken, body: { leaseOwner: randomUUID() } })).status !== 200) {
  runnerToken = '';
}
let runnerId = secret('runner_id');
if (!runnerToken) {
  const enrollment = must(await call('POST', '/runners/enrollment-tokens', { token: accessToken, body: { label: 'link staging probe' } }),
    'creating an enrollment token');
  const registered = must(await call('POST', '/runner/register', {
    body: { enrollmentToken: enrollment.token, name: 'link-staging-probe', hostname: 'link-staging', version: 'link-gateway-client' },
  }), 'registering the probe runner');
  runnerToken = registered.runnerToken;
  runnerId = registered.runnerId;
  keep('runner_token', runnerToken);
  keep('runner_id', runnerId);
}
const extra = must(await call('POST', '/runners/enrollment-tokens', { token: accessToken, body: { label: 'link staging drill runner' } }),
  'creating the drill enrollment token');
keep('enrollment_token', extra.token);

const minted = must(await call('POST', '/runner/link-token', { token: runnerToken, body: { leaseOwner: randomUUID() } }),
  'minting a link token');

const summary = {
  project,
  origin,
  api: `${origin}/api`,
  linkUrl: minted.linkUrl,
  cellId: minted.cellId,
  metrics: metricsUrl,
  owner: { email, passwordFile: path.join(secrets, 'owner_password') },
  probeRunner: { id: runnerId, tokenFile: path.join(secrets, 'runner_token') },
  drillEnrollmentTokenFile: path.join(secrets, 'enrollment_token'),
  caFile: path.join(state, 'tls', 'ca.pem'),
  caBundle: path.join(state, 'tls', 'ca-bundle.pem'),
  envFile: path.join(state, 'compose.env'),
};
writeFileSync(path.join(state, 'staging.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
