import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ISSUED_CREDENTIALS, redactSecrets } from '../common/secret-redaction';

/**
 * A credential in the shape its issuer gives it, put together when the case runs: this repository is public and scanned
 * on push, and a fixture written out whole would be refused there as a leaked key.
 */
export function issued(prefix: string, length: number, alphabet = 'Ex4mpLeN0tReaL9'): string {
  return prefix + alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
}

const PEM_BODY = [issued('MIIEpAIBAAKCAQEA', 48, 'q7Zr2Kd9Xw4Lp0Tn'), issued('', 64, 'Hs3Jm8Vb1Rc6Yf5Q')] as const;

/** A PEM block, its headers first. `newline` is `\\n` for a key kept inside a JSON string. */
function pem(label: string, newline = '\n', headers: readonly string[] = []): string {
  return [`-----BEGIN ${label}-----`, ...headers, ...PEM_BODY, `-----END ${label}-----`].join(newline);
}

const JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiJvcmJpdCIsImlhdCI6MTcyNzI2MDAwMH0', issued('', 43, 'k3Jp_Xq9-Wm2Zt7B')].join('.');

/**
 * Samples of each kind ISSUED_CREDENTIALS names, and what must not survive of each in anything said about it (for a PEM
 * block, its key material). `file-secret-scan.spec.ts` holds them against the scan and `file-tools.pg.spec.ts` against
 * the route.
 */
export const CREDENTIAL_SAMPLES: ReadonlyArray<{ kind: string; shape: string; text: string; secret: readonly string[] }> = [
  ...[
    ['an RSA PEM block', pem('RSA PRIVATE KEY')],
    ['a PKCS#8 PEM block', pem('PRIVATE KEY')],
    ['an EC PEM block', pem('EC PRIVATE KEY')],
    ['an OpenSSH PEM block', pem('OPENSSH PRIVATE KEY')],
    ['an encrypted PEM block', pem('ENCRYPTED PRIVATE KEY')],
    ['a PEM block with encryption headers', pem('RSA PRIVATE KEY', '\n', ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,8F2A7C41D9E03B56', ''])],
    ['a PGP key block with armor headers', pem('PGP PRIVATE KEY BLOCK', '\n', ['Version: GnuPG v2', ''])],
    ['a PEM block inside a JSON string', `{"private_key": "${pem('PRIVATE KEY', '\\n')}\\n"}`],
    ['a PEM block with headers inside a JSON string', `{"key": "${pem('RSA PRIVATE KEY', '\\n', ['Proc-Type: 4,ENCRYPTED', ''])}"}`],
    ['a PEM block in a JSON string inside a JSON string', `{"body": "{\\"key\\": \\"${pem('PRIVATE KEY', '\\\\n')}\\"}"}`],
    ['a PEM block indented in YAML', `    ${pem('EC PRIVATE KEY', '\n    ')}\n`],
    ['a PEM block flattened to one line', pem('PRIVATE KEY', ' ')],
    ['a PEM block with CRLF line breaks', pem('RSA PRIVATE KEY', '\r\n')],
    ['a PEM block cut off before its END line', pem('OPENSSH PRIVATE KEY').split('\n').slice(0, 2).join('\n')],
  ].map(([shape, text]) => ({ kind: 'a private key', shape, text, secret: PEM_BODY.filter((line) => text.includes(line)) })),
  ...[
    ['a signed JSON web token', JWT],
    ['an unsigned JSON web token', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvcmJpdCJ9.'],
  ].map(([shape, text]) => ({ kind: 'a JSON web token', shape, text, secret: [text] })),
  ...[
    ['an Anthropic key', issued('sk-ant-api03-', 95)],
    ['an Anthropic key with - and _ in its body', issued('sk-ant-api03-', 95, 'Ab3_dE-9xY')],
    ['an OpenAI project key', issued('sk-proj-', 64)],
    ['an OpenAI service account key', issued('sk-svcacct-', 64)],
    ['an OpenAI admin key', issued('sk-admin-', 64)],
    ['a legacy OpenAI key', issued('sk-', 48)],
    ['a DeepSeek key', issued('sk-', 32, '0f1e2d3c4b5a6978')],
  ].map(([shape, text]) => ({ kind: 'an API key', shape, text, secret: [text] })),
  ...[
    ['a Stripe live secret key', issued('sk_live_', 24)],
    ['a Stripe live restricted key', issued('rk_live_', 24)],
  ].map(([shape, text]) => ({ kind: 'a Stripe live key', shape, text, secret: [text] })),
  ...[
    ['a GitHub personal access token', issued('ghp_', 36)],
    ['a GitHub OAuth token', issued('gho_', 36)],
    ['a GitHub user-to-server token', issued('ghu_', 36)],
    ['a GitHub server-to-server token', issued('ghs_', 36)],
    ['a GitHub refresh token', issued('ghr_', 36)],
    ['a GitHub fine-grained token', issued('github_pat_', 82, '11AbCdEfG0_hIjKlMn9')],
  ].map(([shape, text]) => ({ kind: 'a GitHub token', shape, text, secret: [text] })),
  ...[
    ['an AWS access key id', issued('AKIA', 16, 'EXAMPLE0KEY1ID2Q')],
    ['an AWS temporary access key id', issued('ASIA', 16, 'EXAMPLE0KEY1ID2Q')],
  ].map(([shape, text]) => ({ kind: 'an AWS access key id', shape, text, secret: [text] })),
  ...['xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'].map((prefix) => ({
    kind: 'a Slack token',
    shape: `a Slack ${prefix} token`,
    text: issued(prefix, 50, '0000-Ex4mpLe-'),
    secret: [issued(prefix, 50, '0000-Ex4mpLe-')],
  })),
  { kind: 'a Google API key', shape: 'a Google API key', text: issued('AIza', 35, 'Ex4mpLe_N0t-ReaL9'), secret: [issued('AIza', 35, 'Ex4mpLe_N0t-ReaL9')] },
  { kind: 'a GitLab token', shape: 'a GitLab personal access token', text: issued('glpat-', 20), secret: [issued('glpat-', 20)] },
  { kind: 'an npm token', shape: 'an npm token', text: issued('npm_', 36), secret: [issued('npm_', 36)] },
];

/**
 * What ordinary test logs and reports hold. The fixtures and slugs are the ones `docs/evidence` holds, in shape: every one
 * of them is what SECRETS' wider rules take out of a text, and none of them is a reason to refuse a file.
 */
export const ORDINARY_LINES: ReadonlyArray<readonly [what: string, line: string]> = [
  ['a password assignment', 'password=xxx'],
  ['a token assignment', 'token=abc'],
  ['a secret assignment', 'secret=shh'],
  ['an env var', 'docker run -e POSTGRES_PASSWORD=hunter2 postgres:16'],
  ['an API key variable', 'ANTHROPIC_API_KEY=abc123 npm test'],
  ['a JSON body', '{"password": "correct horse battery staple", "access_token": "at-9f8e7d6c"}'],
  ['a URL with a local password', 'connect postgres://orbit:orbit@127.0.0.1:5432/orbit_test'],
  ['a git remote with a placeholder', 'https://x-access-token:REDACTED@github.com/org/repo.git'],
  ['a bearer header from a test', 'Authorization: Bearer test-token-123'],
  ['a basic header from a test', 'Authorization: Basic dXNlcjpwYXNz'],
  ['a key fixture with a dash in it', 'apiKey: sk-ant-fixture-0123456789'],
  ['a key fixture shorter than a key', `api_key=${issued('sk-ant-api03-', 12, 'zyxwvutsrqponm')}`],
  ['a fake key named as one', 'PLACEHOLDER = "sk-lab-fake-key-for-tests-01"'],
  ['a run of words after sk-', 'sk-learn-contrib-imbalanced-learn-compat-layer'],
  ['a slug that reads as rk-', '- rk-inside-Orbit-and-outside-of-the-orbit-repository'],
  ['a slug that reads as pk-', 'pod pk-payment-service-6d4f9c7b8d-x2x9z ready'],
  ['a public key half', issued('pk-lf-', 36)],
  ['a Stripe publishable key', issued('pk_live_', 24)],
  ['a Stripe test key', issued('sk_test_', 24)],
  ['a Stripe key shorter than an issued one', issued('sk_live_', 12)],
  ['a PEM label with no key after it', 'error: expected a value starting with -----BEGIN PRIVATE KEY-----'],
  ['a PEM label and a hash on the next line', '-----BEGIN PRIVATE KEY-----\nmerged 083d61fc5a1e9c7b2d4f6a8e0c1b3d5f7a9e2c4b'],
  ['a PEM label and a certificate after it', `-----BEGIN PRIVATE KEY-----\n-----BEGIN CERTIFICATE-----\n${issued('', 64, 'Hs3Jm8Vb1Rc6Yf5Q')}`],
  ['a PEM fixture with no key material in it', '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'],
  ['a public certificate', `-----BEGIN CERTIFICATE-----\n${issued('', 64, 'Hs3Jm8Vb1Rc6Yf5Q')}\n-----END CERTIFICATE-----`],
  ['a public key', `-----BEGIN PUBLIC KEY-----\n${issued('', 64, 'Hs3Jm8Vb1Rc6Yf5Q')}\n-----END PUBLIC KEY-----`],
  ['a commit hash', 'merged 083d61fc5a1e9c7b2d4f6a8e0c1b3d5f7a9e2c4b'],
  ['a sha256', 'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
  ['a uuid', 'run 0199a2b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b'],
  ['a branch name', 'orbit/orbit-project-task-session-compile-wiki-853971'],
  ['a task id in a name', 'orbit/task-t11-2-9-042992 at task-34qPbm0dVgHphzrxqQ2dO0123456789abcd'],
  ['prose about keys', 'Rotate the runner token before it expires; never paste a password into a ticket.'],
  ['Chinese prose', '密钥放在 workspace.env 里，不要写进代码；token 过期后重新登录，password 也一样。'],
];

/** Any eight characters in a row of `secret` that `text` still holds, as the redaction spec reads a leak. */
export function survivingPiece(text: string, secret: string): string | undefined {
  for (let start = 0; start + 8 <= secret.length; start += 1) {
    if (text.includes(secret.slice(start, start + 8))) return secret.slice(start, start + 8);
  }
  return undefined;
}

test('every kind of credential a file is refused for has a sample, and redaction takes each one out too', () => {
  assert.deepEqual(
    [...new Set(CREDENTIAL_SAMPLES.map((sample) => sample.kind))],
    ISSUED_CREDENTIALS.map((credential) => credential.kind),
  );
  for (const { shape, text, secret } of CREDENTIAL_SAMPLES) {
    assert.ok(secret.length > 0, shape);
    const redacted = redactSecrets(text).text;
    for (const piece of secret) assert.ok(!redacted.includes(piece), `redaction left ${shape}`);
  }
});
