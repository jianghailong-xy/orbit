import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { MAX_CHECK_OUTPUT_TAIL } from '../projects/project-integration-job';
import { clipCheckTail, redactCheckOutput, redactFailureDetail } from './check-output-redaction';

/**
 * What a check printed, as the control plane's door makes it fit to store. The rows it goes into are read in
 * `integration-check-output.pg.spec.ts`; this is the rule itself. The passwords are made up, and anything in an
 * issuer's own shape is put together when the case runs, as `secret-redaction.spec.ts` does: this repository is public.
 */

const PASSWORD = 's3cret-pass';
const ADDRESS = `postgres://app:${PASSWORD}@db/orbit`;

/** Half a surrogate pair, which jsonb refuses a whole result for. */
function startsWithHalfAPair(text: string): boolean {
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff;
}

test('the rule answers the table the runner\'s rule answers (src/runner-go/testdata/integration-url-credentials.json)', () => {
  const table = JSON.parse(readFileSync(
    path.resolve(__dirname, '../../../runner-go/testdata/integration-url-credentials.json'),
    'utf8',
  )) as { redacted: Array<{ text: string; want: string }>; unchanged: string[] };
  assert.ok(table.redacted.length > 0 && table.unchanged.length > 0);
  for (const { text, want } of table.redacted) assert.equal(redactCheckOutput(text), want);
  for (const text of table.unchanged) assert.equal(redactCheckOutput(text), text);
});

test('the report: the address a check printed reads as it does in the log', () => {
  assert.equal(redactCheckOutput(`dial ${ADDRESS}\n`), 'dial postgres://[redacted]@db/orbit\n');
  assert.equal(redactCheckOutput('postgres://[redacted]@db/orbit'), 'postgres://[redacted]@db/orbit', 'twice is once');
});

test('a credential only a shape can tell goes too, on any runner', () => {
  const github = `gh${'p_'}${'Ex4mpLeN0tReaL9'.repeat(3)}`;
  for (const [text, gone] of [
    ['Authorization: Bearer abcDEF0123456789xyz', 'abcDEF0123456789xyz'],
    ['PGPASSWORD=hunter2hunter2 psql -h db', 'hunter2hunter2'],
    [`remote: using ${github}`, github],
  ] as const) {
    const redacted = redactCheckOutput(text);
    assert.ok(!redacted.includes(gone), `${text} came out ${redacted}`);
    assert.ok(redacted.includes('[redacted]'), `${text} came out ${redacted}`);
  }
});

test('what a test runner prints about a failure reads as it was printed', () => {
  for (const line of [
    '--- FAIL: TestPasswordRuleRejectsShortOnes (0.01s)',
    'FAIL\torbit/runner\t600.036s',
    'not ok 2 - the token is refreshed before it expires',
    '   × secret rotation keeps the old key 3ms',
    'panic: test timed out after 10m0s',
    '\trunning tests:',
    '\t\tTestRealClaudeAcceptsASetModel (9m59s)',
    'Failure lines from the whole output:',
    'More failure lines omitted: 3',
  ]) {
    assert.equal(redactCheckOutput(line), line);
  }
});

test('NUL goes first, so a secret it sits inside is still recognised', () => {
  assert.equal(redactCheckOutput('a\0b\0'), 'ab');
  assert.equal(redactCheckOutput(`postgres://app:s3\0cret-pass@db/orbit`), 'postgres://[redacted]@db/orbit');
  // A UTF-16 dump has one in every other byte.
  assert.equal(
    redactCheckOutput([...ADDRESS].join('\0')),
    'postgres://[redacted]@db/orbit',
  );
});

test('a tail short of the cap is kept to the byte, whatever it starts with', () => {
  const tail = `someone@example.invalid could not ${ADDRESS.slice(0, 11)}db/orbit\n`;
  assert.equal(clipCheckTail(tail), tail);
  assert.equal(clipCheckTail(''), '');
});

test('a tail the runner cut inside an address keeps no part of the password', () => {
  // Every place an old runner's 16 KiB can start: it sends raw text, and what it cut is not an address any more.
  for (let start = 0; start < ADDRESS.length; start += 1) {
    const printed = ADDRESS.slice(start);
    const tail = printed + 'x'.repeat(MAX_CHECK_OUTPUT_TAIL - printed.length);
    assert.equal(Buffer.byteLength(tail, 'utf8'), MAX_CHECK_OUTPUT_TAIL);
    const clipped = clipCheckTail(tail);
    const inPassword = ADDRESS.indexOf(PASSWORD);
    const rest = start <= inPassword ? PASSWORD : PASSWORD.slice(start - inPassword);
    if (rest !== '') assert.ok(!clipped.includes(`${rest}@`), `starting at ${start}: ${clipped.slice(0, 60)}`);
    assert.ok(!clipped.includes(`${PASSWORD.slice(-3)}@`), `starting at ${start}: ${clipped.slice(0, 60)}`);
  }
});

test('the part of a tail nobody quoted is what the cut takes; its end stays, and so does a tail with no whitespace', () => {
  const end = '\nFailure lines from the whole output:\n--- FAIL: TestX (0.00s)';
  const atTheCap = 'y'.repeat(MAX_CHECK_OUTPUT_TAIL - end.length) + end;
  const clipped = clipCheckTail(atTheCap);
  assert.ok(clipped.endsWith(end));
  assert.equal(clipped.length, MAX_CHECK_OUTPUT_TAIL - 256);

  const over = clipCheckTail('z'.repeat(5 * MAX_CHECK_OUTPUT_TAIL) + end);
  assert.ok(over.endsWith(end));
  assert.equal(over.length, MAX_CHECK_OUTPUT_TAIL);
});

test('a marker that lengthens the text still ends inside the cap, and never on half a surrogate pair', () => {
  // Each `a://b@c ` comes out `a://[redacted]@c `: within the runner's 16 KiB going in, far past it coming out.
  const addresses = 'a://b@c '.repeat(2_000);
  assert.ok(Buffer.byteLength(addresses, 'utf8') <= MAX_CHECK_OUTPUT_TAIL);
  assert.ok(redactCheckOutput(addresses).length > MAX_CHECK_OUTPUT_TAIL);
  assert.ok(clipCheckTail(addresses).length <= MAX_CHECK_OUTPUT_TAIL);

  // An emoji at every offset the cut can land on: both branches of the clip, either parity.
  for (const pad of [0, 1, 2, 3]) {
    for (const tail of [
      'x'.repeat(pad) + '\u{1F600}'.repeat(4_000),
      'x'.repeat(pad) + '\u{1F600}'.repeat(9_000),
      `${'a://b@c '.repeat(1_500)}${'x'.repeat(pad)}${'\u{1F600}'.repeat(1_000)}`,
    ]) {
      const clipped = clipCheckTail(tail);
      assert.ok(!startsWithHalfAPair(clipped), `pad ${pad}, ${tail.length} units`);
      assert.ok(clipped.length <= MAX_CHECK_OUTPUT_TAIL);
    }
  }
});

test('a tail counts in bytes where the runner does: one of many-byte characters at the cap was cut too', () => {
  const printed = ADDRESS.slice(ADDRESS.indexOf(PASSWORD) + 2);
  const wide = printed + '\u4e2d'.repeat(Math.ceil((MAX_CHECK_OUTPUT_TAIL - printed.length) / 3));
  assert.ok(wide.length < MAX_CHECK_OUTPUT_TAIL, 'short of the cap in characters');
  assert.ok(!clipCheckTail(wide).includes(`${PASSWORD.slice(2)}@`));
});

test('a failure detail keeps its shape: its strings are held to the rule, and nothing else moves', () => {
  const detail = {
    command: 'scripts/worktree-overlay.sh',
    detail: `failed (exit status 1): dial ${ADDRESS}\0\n`,
    nested: { list: [`fatal: https://bob:hunter2pass@example.invalid/r.git`, 3, true, null] },
    limitSeconds: 600,
    abandoned: false,
  };
  assert.deepEqual(redactFailureDetail(detail), {
    command: 'scripts/worktree-overlay.sh',
    detail: 'failed (exit status 1): dial postgres://[redacted]@db/orbit\n',
    nested: { list: ['fatal: https://[redacted]@example.invalid/r.git', 3, true, null] },
    limitSeconds: 600,
    abandoned: false,
  });
  assert.equal(redactFailureDetail(null), null);
  assert.equal(redactFailureDetail(undefined), undefined);
});

test('no chunk a runner can send holds this server\'s event loop', () => {
  // This door runs for every chunk of every check. Linear rules read each of these in milliseconds; a scheme with no
  // bound is scanned again from every letter of a run, a second and a half over the first of them at the 64 KiB a chunk
  // may be. Four times that is a minute's difference, which no loaded host is mistaken for.
  const SIZE = 4 * 64 * 1024;
  const fill = (piece: string): string => piece.repeat(Math.ceil(SIZE / piece.length)).slice(0, SIZE);
  for (const text of [
    fill('a'),
    fill('a.'),
    fill('a:'),
    fill('a:/'),
    fill('a://'),
    fill('a://b'),
    fill('a://b@'),
    fill('@'),
    fill(':'),
    fill('/'),
    fill('Bearer '),
    fill('Basic a1 '),
    fill('password='),
    fill('password '),
    fill('password"'),
    `password${' '.repeat(SIZE)}`,
    `token="${'\\'.repeat(SIZE)}`,
    fill('-----BEGIN PRIVATE KEY-----'),
    fill('eyJ-'),
    fill('eyJ.a.'),
    fill('sk-'),
    fill('\0'),
    fill('\u{1F600}'),
  ]) {
    const started = performance.now();
    redactCheckOutput(text);
    const took = performance.now() - started;
    assert.ok(took < 5_000, `${JSON.stringify(text.slice(0, 16))}… took ${Math.round(took)} ms`);
  }
});
