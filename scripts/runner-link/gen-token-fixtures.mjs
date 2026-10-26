#!/usr/bin/env node
// Writes src/link-gateway/testdata/a3-tokens.json: connection tokens and the verdict the apiserver's own verifier
// (src/apiserver/src/runner-api/runner-link-token.ts, verifyRunnerLinkToken) gives each, which the link gateway's
// Go verifier must reproduce (src/link-gateway/token_test.go). The tokens are signed by that module's
// signRunnerLinkToken where it can make them, and with node:crypto where a test needs a token it would never sign.
// Each run signs with a fresh key; only the public key is written.
//
//   npx tsc -p src/apiserver/tsconfig.json     # or npm run build -w @orbit/apiserver
//   node scripts/runner-link/gen-token-fixtures.mjs
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compiled = path.join(repo, 'src/apiserver/dist/runner-api/runner-link-token.js');
if (!existsSync(compiled)) {
  console.error(`missing ${compiled}: build the apiserver first (npx tsc -p src/apiserver/tsconfig.json)`);
  process.exit(1);
}
const require = createRequire(import.meta.url);
const a3 = require(compiled);

const { privateKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519').privateKey;
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const { config, problems } = a3.readRunnerLink({
  signingKey: Buffer.from(pem).toString('base64'),
  linkUrl: 'wss://link.test.invalid',
  gatewayToken: 'g'.repeat(32),
});
if (!config) throw new Error(problems.join('; '));

const subject = {
  runnerId: '0190a0b0-0000-7000-8000-000000000001',
  ownerId: '0190a0b0-0000-7000-8000-000000000002',
  cellId: 'cell-1',
  leaseOwner: '0190a0b0-0000-4000-8000-000000000003',
  credential: '0123456789abcdef0123456789abcdef',
};
const iat = new Date('2026-10-25T06:00:00.000Z');
const { token: valid, claims } = a3.signRunnerLinkToken(config, subject, iat);
const expMs = claims.exp * 1000;

const segment = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
// A token with any header and payload, signed as the apiserver signs (or with another key).
const craft = (header, payload, key = config.signingKey) => {
  const input = `${segment(header)}.${segment(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
};
const header = { alg: 'EdDSA', typ: 'JWT', kid: config.keyId };
const flip = (s) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
const [h, p, sig] = valid.split('.');
const padded = `${h}==.${p}`;

const cases = [
  ['valid, a minute after it was issued', valid, iat.getTime() + 60_000],
  ['valid, the last millisecond before it expires', valid, expMs - 1],
  ['expired, at its exp', valid, expMs],
  ['expired, a day later', valid, expMs + 86_400_000],
  ['signature altered', `${h}.${p}.${flip(sig)}`, iat.getTime()],
  ['signature cut short', `${h}.${p}.${sig.slice(0, 40)}`, iat.getTime()],
  ['signature missing', `${h}.${p}.`, iat.getTime()],
  ['payload altered after signing', `${h}.${segment({ ...claims, runnerId: 'someone-else' })}.${sig}`, iat.getTime()],
  ['signed by another key', craft(header, claims, other), iat.getTime()],
  ['kid names another key, signature by this one', craft({ ...header, kid: 'another-key' }, claims), iat.getTime()],
  ['no kid', craft({ alg: 'EdDSA', typ: 'JWT' }, claims), iat.getTime()],
  ['alg none', `${segment({ alg: 'none', typ: 'JWT' })}.${p}.`, iat.getTime()],
  ['alg HS256', craft({ ...header, alg: 'HS256' }, claims), iat.getTime()],
  ['header not JSON', `${segment('not json')}.${p}.${sig}`, iat.getTime()],
  ['payload not JSON', `${h}.${segment('{"aud":')}.${sig}`, iat.getTime()],
  ['header is a JSON string', craft('"EdDSA"', claims), iat.getTime()],
  ['two parts', `${h}.${p}`, iat.getTime()],
  ['four parts', `${valid}.extra`, iat.getTime()],
  ['empty', '', iat.getTime()],
  ['another audience', craft(header, { ...claims, aud: 'orbit-other' }), iat.getTime()],
  ['audience as an array', craft(header, { ...claims, aud: ['orbit-runner-link'] }), iat.getTime()],
  ['no audience', craft(header, (({ aud, ...rest }) => rest)(claims)), iat.getTime()],
  ['payload is a JSON array', craft(header, [claims]), iat.getTime()],
  ['payload is JSON null', craft(header, null), iat.getTime()],
  ['exp as a string', craft(header, { ...claims, exp: String(claims.exp) }), iat.getTime()],
  ['no exp', craft(header, (({ exp, ...rest }) => rest)(claims)), iat.getTime()],
  ['fractional exp, before it', craft(header, { ...claims, exp: claims.exp + 0.5 }), expMs + 499],
  ['fractional exp, at it', craft(header, { ...claims, exp: claims.exp + 0.5 }), expMs + 500],
  ['padded header segment', `${padded}.${sign(null, Buffer.from(padded), config.signingKey).toString('base64url')}`, iat.getTime()],
].map(([name, token, nowMs]) => {
  let verdict = 'OK';
  let verified = null;
  try {
    verified = a3.verifyRunnerLinkToken(token, config.publicKey, new Date(nowMs));
  } catch (err) {
    if (!(err instanceof a3.RunnerLinkTokenRefused)) throw err;
    verdict = err.reason;
  }
  return verdict === 'OK' ? { name, token, nowMs, verdict, claims: verified } : { name, token, nowMs, verdict };
});

const out = path.join(repo, 'src/link-gateway/testdata/a3-tokens.json');
writeFileSync(out, `${JSON.stringify({
  generatedBy: 'scripts/runner-link/gen-token-fixtures.mjs, with src/apiserver/src/runner-api/runner-link-token.ts',
  publicKeyPem: config.publicKey.export({ format: 'pem', type: 'spki' }),
  kid: config.keyId,
  cases,
}, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${path.relative(repo, out)}`);
for (const c of cases) console.log(`  ${c.verdict.padEnd(9)} ${c.name}`);
