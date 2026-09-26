import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactErrorText } from '../watches/watch-redaction';
import { REDACTED, redactSecrets } from './secret-redaction';

/**
 * docs/wiki-design.md §10.2: fifty or more secret shapes, and not one of them may leak. One case per shape. Each
 * seed names what must be gone and, where the text around the secret says something a reader needs, what must stay.
 */

/**
 * A credential in the shape its issuer gives it, put together when the case runs: this repository is public and
 * scanned on push, and a fixture written out whole would be refused there as a leaked key.
 */
function issued(prefix: string, length: number, alphabet = 'Ex4mpLeN0tReaL9'): string {
  return prefix + alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
}

const PEM_BODY = [issued('MIIEpAIBAAKCAQEA', 48, 'q7Zr2Kd9Xw4Lp0Tn'), issued('', 64, 'Hs3Jm8Vb1Rc6Yf5Q')] as const;

/** A PEM block, put together the same way. `newline` is `\\n` for a key kept inside a JSON string. */
function pem(label: string, newline = '\n'): string {
  return [`-----BEGIN ${label}-----`, ...PEM_BODY, `-----END ${label}-----`].join(newline);
}

const AWS_SECRET = issued('', 40, 'Qm9vT3xR/7vKp+2WsZ1c');
const HEX_KEY = issued('0x', 64, '9e1b7c3a5f0d2e84');
const HEX_TOKEN = issued('', 40, '0f1e2d3c4b5a6978');
const JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiJvcmJpdCIsImlhdCI6MTcyNzI2MDAwMH0', issued('', 43, 'k3Jp_Xq9-Wm2Zt7B')].join('.');
const UNSIGNED_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvcmJpdCJ9.';

/** Keys in the shape their provider issues them. */
const ISSUED: ReadonlyArray<readonly [shape: string, key: string]> = [
  ['an Anthropic API key (sk-ant-)', issued('sk-ant-api03-', 95)],
  ['an OpenAI project key (sk-proj-)', issued('sk-proj-', 64)],
  ['a public key half (pk-)', issued('pk-lf-', 36)],
  ['a restricted key (rk-)', issued('rk-', 32)],
  ['a Stripe live secret key (sk_live_)', issued('sk_live_', 24)],
  ['a GitHub personal access token (ghp_)', issued('ghp_', 36)],
  ['a GitHub OAuth token (gho_)', issued('gho_', 36)],
  ['a GitHub user-to-server token (ghu_)', issued('ghu_', 36)],
  ['a GitHub server-to-server token (ghs_)', issued('ghs_', 36)],
  ['a GitHub refresh token (ghr_)', issued('ghr_', 36)],
  ['a GitHub fine-grained token (github_pat_)', issued('github_pat_', 82, '11AbCdEfG0_hIjKlMn9')],
  ['an AWS access key id (AKIA)', issued('AKIA', 16, 'EXAMPLE0KEY1ID2Q')],
  ['an AWS temporary access key id (ASIA)', issued('ASIA', 16, 'EXAMPLE0KEY1ID2Q')],
  ['a Slack bot token (xoxb-)', issued('xoxb-', 50, '0000-Ex4mpLe-')],
  ['a Slack user token (xoxp-)', issued('xoxp-', 50, '0000-Ex4mpLe-')],
  ['a Slack app token (xoxa-)', issued('xoxa-', 50, '0000-Ex4mpLe-')],
  ['a Slack refresh token (xoxr-)', issued('xoxr-', 50, '0000-Ex4mpLe-')],
  ['a Slack session token (xoxs-)', issued('xoxs-', 50, '0000-Ex4mpLe-')],
  ['a Google API key (AIza)', issued('AIza', 35, 'Ex4mpLe_N0t-ReaL9')],
  ['a GitLab personal access token (glpat-)', issued('glpat-', 20)],
  ['an npm token (npm_)', issued('npm_', 36)],
];

interface Seed {
  shape: string;
  text: string;
  /** What must be gone: each piece whole, and any eight characters in a row of it. */
  secret: string | readonly string[];
  /** What must stay: the secret is taken out, not the sentence around it. */
  keeps?: readonly string[];
  literals?: readonly string[];
}

const SEEDS: readonly Seed[] = [
  // A value given to a name that says it holds a secret. The first three are what a `\b` before the name let
  // through, `_` being a word character.
  { shape: 'an env var ending in _PASSWORD', text: 'docker run -e POSTGRES_PASSWORD=hunter2 postgres:16', secret: 'hunter2', keeps: ['POSTGRES_PASSWORD=', ' postgres:16'] },
  { shape: 'an env var ending in _API_KEY', text: 'ANTHROPIC_API_KEY=abc123', secret: 'abc123', keeps: ['ANTHROPIC_API_KEY='] },
  { shape: 'an env var ending in _TOKEN', text: 'ORBIT_RUNNER_TOKEN=xyz', secret: 'xyz', keeps: ['ORBIT_RUNNER_TOKEN='] },
  { shape: 'an env var ending in _PASSWD', text: 'MYSQL_ROOT_PASSWD=r00t-Pa55', secret: 'r00t-Pa55', keeps: ['MYSQL_ROOT_PASSWD='] },
  { shape: 'an env var ending in _PWD', text: 'LDAP_BIND_PWD=b1nd-Pa55', secret: 'b1nd-Pa55', keeps: ['LDAP_BIND_PWD='] },
  { shape: 'an env var ending in _SECRET', text: 'JWT_SECRET=4f9a1c77e2d8b6053a1e', secret: '4f9a1c77e2d8b6053a1e', keeps: ['JWT_SECRET='] },
  { shape: 'an env var with SECRET inside and ACCESS_KEY at its end', text: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, secret: AWS_SECRET, keeps: ['AWS_SECRET_ACCESS_KEY='] },
  { shape: 'an env var ending in _ACCESS_KEY', text: 'MINIO_ACCESS_KEY=m1nio-Acc3ss', secret: 'm1nio-Acc3ss', keeps: ['MINIO_ACCESS_KEY='] },
  { shape: 'an env var ending in _PRIVATE_KEY, on one line', text: `DEPLOY_PRIVATE_KEY=${HEX_KEY}`, secret: HEX_KEY, keeps: ['DEPLOY_PRIVATE_KEY='] },
  { shape: 'a name glued to the word with no underscore (PGPASSWORD)', text: 'PGPASSWORD=pg-S3cret psql -h db orbit', secret: 'pg-S3cret', keeps: ['PGPASSWORD=', ' psql -h db orbit'] },
  { shape: 'more of the name after the word (ORBIT_API_KEY_PROD)', text: 'ORBIT_API_KEY_PROD=pr0d-K3y-77', secret: 'pr0d-K3y-77', keeps: ['ORBIT_API_KEY_PROD='] },
  { shape: 'a lowercase name', text: 'db_password=l0wer-S3cret', secret: 'l0wer-S3cret', keeps: ['db_password='] },
  { shape: 'a camelCase name in code', text: "const config = { dbPassword: 'camel-S3cret', port: 5432 };", secret: 'camel-S3cret', keeps: ['dbPassword: ', 'port: 5432'] },
  { shape: 'a quoted JSON key', text: '{"clientId": "orbit-web", "clientSecret": "js0n-S3cret"}', secret: 'js0n-S3cret', keeps: ['"clientId": "orbit-web"', '"clientSecret": "'] },
  { shape: 'a quoted value with spaces in it', text: '{"password": "correct horse battery staple", "user": "ops"}', secret: 'correct horse battery staple', keeps: ['"user": "ops"'] },
  { shape: 'a single-quoted value', text: "password='single qu0ted s3cret' --verbose", secret: 'single qu0ted s3cret', keeps: [' --verbose'] },
  { shape: 'a quoted value holding an escaped quote', text: 'password="esc\\"aped-S3cret" rest', secret: ['esc\\"aped-S3cret', 'aped-S3cret'], keeps: [' rest'] },
  { shape: 'a YAML mapping', text: 'redis:\n  host: cache\n  redis_password: yaml-S3cret\n  port: 6379', secret: 'yaml-S3cret', keeps: ['host: cache', 'port: 6379'] },
  { shape: 'spaces around the equals sign', text: 'SECRET_KEY_BASE = 9f86d081884c7d659a2feaa0c55ad015', secret: '9f86d081884c7d659a2feaa0c55ad015', keeps: ['SECRET_KEY_BASE = '] },
  { shape: 'a shell export', text: 'export DEPLOY_TOKEN=sh3ll-Exp0rt-T0ken && ./deploy.sh', secret: 'sh3ll-Exp0rt-T0ken', keeps: ['export DEPLOY_TOKEN=', ' && ./deploy.sh'] },
  { shape: 'a URL query parameter', text: 'GET https://api.example.com/v1/me?access_token=qp-T0ken-123&fields=id', secret: 'qp-T0ken-123', keeps: ['https://api.example.com/v1/me?access_token='] },
  { shape: 'an .npmrc auth line', text: '//registry.npmjs.org/:_authToken=npmrc-L3gacy-T0ken', secret: 'npmrc-L3gacy-T0ken', keeps: ['//registry.npmjs.org/:_authToken='] },
  { shape: 'an ADO.NET connection string', text: 'Server=db;Database=orbit;User Id=sa;Password=Str0ng!Pass;Encrypt=true', secret: 'Str0ng!Pass', keeps: ['Server=db;Database=orbit;User Id=sa;Password='] },
  { shape: "a JDBC URL's password parameter", text: 'jdbc:mysql://db:3306/app?user=root&password=jdbc-S3cret', secret: 'jdbc-S3cret', keeps: ['jdbc:mysql://db:3306/app?user=root&password='] },
  { shape: 'an HTTP header with a kebab-case name', text: 'X-Api-Key: hdr-K3y-5550123', secret: 'hdr-K3y-5550123', keeps: ['X-Api-Key: '] },
  { shape: 'a hash rocket', text: "['user' => 'ops', 'password' => 'php-S3cret']", secret: 'php-S3cret', keeps: ["'user' => 'ops'", "'password' => '"] },
  { shape: 'a Go short assignment', text: 'password := "go-S3cret"', secret: 'go-S3cret', keeps: ['password := "'] },
  { shape: 'a Java properties key with dots', text: 'spring.datasource.password=spring-S3cret', secret: 'spring-S3cret', keeps: ['spring.datasource.password='] },
  { shape: 'a JSON body with no spaces', text: '{"access_token":"at-9f8e7d6c","refresh_token":"rt-1a2b3c4d","expires_in":3600}', secret: ['at-9f8e7d6c', 'rt-1a2b3c4d'], keeps: ['"expires_in":3600'] },
  { shape: 'a command-line flag written with =', text: 'pg_dump --db-password=fl4g-S3cret --host db', secret: 'fl4g-S3cret', keeps: ['--db-password=', ' --host db'] },
  { shape: 'an AWS credentials file', text: `[default]\nregion = us-east-1\naws_secret_access_key = ${AWS_SECRET}\n`, secret: AWS_SECRET, keeps: ['region = us-east-1', 'aws_secret_access_key = '] },

  // An authorization scheme and its credentials.
  { shape: 'an Authorization: Bearer header', text: 'curl -H "Authorization: Bearer or9aF3kQ2mX7pLz" https://api.orbit.dev/v1', secret: 'or9aF3kQ2mX7pLz', keeps: ['Authorization: Bearer ', '" https://api.orbit.dev/v1'] },
  { shape: 'an Authorization: Basic header', text: 'Authorization: Basic dXNlcjpwYXNzd29yZA==', secret: 'dXNlcjpwYXNzd29yZA==', keeps: ['Authorization: Basic '] },
  { shape: 'a lowercase bearer scheme', text: 'authorization: bearer l0wer-9f8e7d6c5b4a', secret: 'l0wer-9f8e7d6c5b4a', keeps: ['authorization: bearer '] },
  { shape: 'a bearer credential of twenty lowercase letters or more', text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz; retrying', secret: 'abcdefghijklmnopqrstuvwxyz', keeps: ['Authorization: Bearer ', '; retrying'] },

  // The userinfo of a URL.
  { shape: "a postgres URL's userinfo", text: 'connect postgres://orbit:hunter2@db:5432/orbit refused', secret: 'orbit:hunter2', keeps: ['connect postgres://', '@db:5432/orbit refused'] },
  { shape: 'a URL whose scheme has a + in it', text: 'MONGO_URL=mongodb+srv://admin:M0ngo-S3cret@cluster0.example.net/app', secret: 'admin:M0ngo-S3cret', keeps: ['mongodb+srv://', '@cluster0.example.net/app'] },
  { shape: 'a URL password holding an @', text: 'redis://:p@ssw0rd@cache:6379/0', secret: ['p@ssw0rd', 'ssw0rd'], keeps: ['@cache:6379/0'] },
  { shape: 'a token and its user in a git remote', text: 'git remote set-url origin https://x-access-token:r3mote-T0ken@github.com/org/repo.git', secret: 'r3mote-T0ken', keeps: ['@github.com/org/repo.git'] },
  { shape: 'a token that is the whole userinfo', text: `git clone https://${HEX_TOKEN}@github.com/org/repo.git`, secret: HEX_TOKEN, keeps: ['git clone https://', '@github.com/org/repo.git'] },

  // A PEM private key.
  ...['RSA PRIVATE KEY', 'PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK'].map((label) => ({
    shape: `a PEM block labelled ${label}`,
    text: `the deploy key follows:\n${pem(label)}\nand nothing else.`,
    secret: PEM_BODY,
    keeps: ['the deploy key follows:\n', '\nand nothing else.'],
  })),
  {
    shape: 'a PEM block inside a JSON string',
    text: `{"type": "service_account", "private_key": "${pem('PRIVATE KEY', '\\n')}\\n", "client_email": "ci@orbit.iam"}`,
    secret: PEM_BODY,
    keeps: ['"type": "service_account"', '"client_email": "ci@orbit.iam"'],
  },
  { shape: 'a PEM block cut off before its END line', text: `cat id_ed25519:\n${pem('OPENSSH PRIVATE KEY').split('\n').slice(0, 2).join('\n')}`, secret: PEM_BODY[0], keeps: ['cat id_ed25519:\n'] },

  // A JSON web token.
  { shape: 'a signed JSON web token', text: `session=${JWT} for ops`, secret: JWT, keeps: ['session=', ' for ops'] },
  { shape: 'an unsigned JSON web token', text: `id hint ${UNSIGNED_JWT} ignored`, secret: UNSIGNED_JWT, keeps: ['id hint ', ' ignored'] },

  ...ISSUED.map(([shape, key]) => ({ shape, text: `the key ${key} was rejected`, secret: key, keeps: ['the key ', ' was rejected'] })),

  // The values of the owner's workspace.env, whatever their shape.
  { shape: 'a workspace.env value under a name no rule knows', text: 'DB_PASS=Tr0ub4dor&3 psql -h db', literals: ['Tr0ub4dor&3'], secret: 'Tr0ub4dor&3', keeps: ['DB_PASS=', ' psql -h db'] },
  { shape: 'a workspace.env value inside a URL path', text: 'POST https://hooks.example.com/services/T0000/B0000/whk-S3cret-Path failed: 404', literals: ['T0000/B0000/whk-S3cret-Path'], secret: 'T0000/B0000/whk-S3cret-Path', keeps: ['https://hooks.example.com/services/', ' failed: 404'] },
  { shape: 'a workspace.env value holding regex and replacement characters', text: 'login p4$$w0rd.*+?$& rejected', literals: ['p4$$w0rd.*+?$&'], secret: 'p4$$w0rd.*+?$&', keeps: ['login ', ' rejected'] },
  { shape: 'two workspace.env values, one inside the other', text: 'primary abcd-1234-efgh-5678, fallback abcd-1234', literals: ['abcd-1234', 'abcd-1234-efgh-5678'], secret: ['abcd-1234-efgh-5678', 'efgh-5678'], keeps: ['primary ', ', fallback '] },
  { shape: 'a workspace.env value that appears more than once', text: 'first r3peated-Value, then r3peated-Value again', literals: ['r3peated-Value'], secret: 'r3peated-Value', keeps: ['first ', ', then ', ' again'] },
  { shape: 'a workspace.env value glued inside a longer token', text: 'id=preGLUEDs3cretpost', literals: ['GLUEDs3cret'], secret: 'GLUEDs3cret', keeps: ['id=pre', 'post'] },
  { shape: 'a workspace.env value spanning lines', text: 'cert:\nline-one-Ab12\nline-two-Cd34\nend', literals: ['line-one-Ab12\nline-two-Cd34'], secret: ['line-one-Ab12', 'line-two-Cd34'], keeps: ['cert:\n', '\nend'] },
  // Replaced before the shapes, `postgres` would take the scheme the URL's userinfo is found after.
  { shape: 'a workspace.env value that is also the scheme of a URL holding a password', text: 'DATABASE_URL=postgres://orbit:hunter2@db/orbit', literals: ['postgres'], secret: ['orbit:hunter2', 'postgres'], keeps: ['DATABASE_URL=', '@db/orbit'] },
];

/** Any eight characters in a row of `secret` (all of it, when it is shorter) that `text` still holds. */
function survivingPiece(text: string, secret: string): string | undefined {
  const width = Math.min(8, secret.length);
  for (let start = 0; start + width <= secret.length; start += 1) {
    const piece = secret.slice(start, start + width);
    if (text.includes(piece)) return piece;
  }
  return undefined;
}

test('the seeds are fifty or more shapes, each its own', () => {
  assert.ok(SEEDS.length >= 50, `${SEEDS.length} seeds`);
  assert.equal(new Set(SEEDS.map((seed) => seed.shape)).size, SEEDS.length, 'two seeds share a shape');
  assert.equal(new Set(SEEDS.map((seed) => seed.text)).size, SEEDS.length, 'two seeds share a text');
});

for (const seed of SEEDS) {
  test(`redacts ${seed.shape}`, () => {
    const secrets = [seed.secret].flat();
    for (const secret of secrets) assert.ok(seed.text.includes(secret), `the seed does not hold ${secret}`);
    const options = { literals: seed.literals };
    const { text, redacted } = redactSecrets(seed.text, options);
    assert.equal(redacted, true, text);
    assert.ok(text.includes(REDACTED), text);
    for (const secret of secrets) assert.equal(survivingPiece(text, secret), undefined, `${secret} leaked: ${text}`);
    for (const kept of seed.keeps ?? []) assert.ok(text.includes(kept), `lost ${JSON.stringify(kept)}: ${text}`);
    assert.deepEqual(redactSecrets(text, options), { text, redacted: false }, 'a second pass changed the text');
  });
}

/** Ordinary text comes back exactly as it was, and is not reported as redacted. */
function unchanged(text: string, literals?: readonly string[]): void {
  assert.deepEqual(redactSecrets(text, { literals }), { text, redacted: false });
}

test('leaves prose about tokens, passwords and keys as it is', () => {
  unchanged('Rotate the runner token before it expires; never paste a password, a secret or an API key into a ticket.');
});

test('leaves the names of secrets as they are when no value is given', () => {
  unchanged('Set POSTGRES_PASSWORD and ANTHROPIC_API_KEY in the workspace env, then restart the runner.');
});

test('leaves Bearer and Basic as they are when a word follows them, not a credential', () => {
  unchanged('Bearer tokens authenticate the runner; a basic example lives in docs/runner.md, and Basic auth is off.');
});

test('leaves token counts as they are', () => {
  unchanged('usage: input_tokens=1234, output_tokens: 56, max_tokens=4096, "cache_read_input_tokens": 0');
});

test('leaves Orbit identifiers, paths and plain URLs as they are', () => {
  unchanged(
    'Branch orbit/orbit-project-task-session-compile-wiki-853971 at 083d61fc5 (task 34UuASrNeTo404R6xpEeS, run '
      + '0199a2b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b) touched src/apiserver/src/common/secret-redaction.ts; see '
      + 'https://github.com/acme/orbit/pull/12, clone git@github.com:acme/orbit.git or write to ops@example.com.',
  );
});

test('leaves a manifest that names a secret without holding one as it is', () => {
  unchanged('env:\n  - name: DB_PASSWORD\n    valueFrom:\n      secretKeyRef:\n        name: db-secret\n        key: password\n');
});

test('leaves Chinese prose as it is', () => {
  unchanged('密钥放在 workspace.env 里，不要写进代码；token 过期后重新登录，password 也一样。');
});

test('leaves a workspace.env value shorter than four characters where it is', () => {
  unchanged('the dev server is on', ['dev', 'on', '']);
});

test('redactErrorText takes POSTGRES_PASSWORD=hunter2 out of a failure', () => {
  assert.equal(
    redactErrorText('createTurn failed: POSTGRES_PASSWORD=hunter2 was rejected by db'),
    'createTurn failed: POSTGRES_PASSWORD=[redacted] was rejected by db',
  );
});

test('redactErrorText stores the failure watch-security S-04 throws as it did before', () => {
  const failure = 'connect postgres://orbit:hunter2@db.internal:5432/orbit refused; Authorization: Bearer abcdefghijklmnopqrstuvwxyz; '
    + 'api_key=sk-ant-api03-zyxwvutsrqponmlkjihg token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
  assert.equal(
    redactErrorText(failure),
    'connect postgres://[redacted]@db.internal:5432/orbit refused; Authorization: Bearer [redacted]; api_key=[redacted] token=[redacted]',
  );
});

test('redactErrorText takes a secret out before it cuts the text at a thousand characters', () => {
  // Cut first, the token would end at the thousandth character too short for its shape, and its first part stay.
  const failure = `${'x'.repeat(980)} ${issued('ghp_', 36)} ${'y'.repeat(100)}`;
  assert.equal(redactErrorText(failure), `${'x'.repeat(980)} ${REDACTED} ${'y'.repeat(8)}…`);
});
