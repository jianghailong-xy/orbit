import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { escapeHtml, firstNameOf, renderWelcomeEmail, type WelcomeSignIn } from './welcome-email.template';

/**
 * Snapshot tests of the welcome email (docs/welcome-email-design.md §3.4): three sign-in lines × managed
 * runner on and off, HTML and plain text each. The snapshots live in src/email/__snapshots__ (this file
 * runs from build/email). `UPDATE_SNAPSHOTS=1 npm test` writes them again; review the diff.
 */
const SNAPSHOTS = join(__dirname, '..', '..', 'src', 'email', '__snapshots__');

function matchSnapshot(name: string, actual: string) {
  const file = join(SNAPSHOTS, name);
  if (process.env.UPDATE_SNAPSHOTS === '1' || !existsSync(file)) {
    if (process.env.UPDATE_SNAPSHOTS !== '1' && process.env.CI) assert.fail(`snapshot ${name} is missing`);
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, 'utf8'), `snapshot ${name} differs; run with UPDATE_SNAPSHOTS=1 if the change is meant`);
}

const SIGN_INS: Record<string, WelcomeSignIn> = {
  google: { kind: 'GOOGLE_SIGNUP' },
  'admin-password': { kind: 'ADMIN_PASSWORD', admin: 'Alex Rivera' },
  'admin-passwordless': { kind: 'ADMIN_PASSWORDLESS', admin: 'Alex Rivera' },
};

for (const [variant, signIn] of Object.entries(SIGN_INS)) {
  for (const managedRunner of [true, false]) {
    const name = `welcome-${variant}-${managedRunner ? 'managed' : 'no-runner'}`;
    test(`welcome email snapshot: ${name}`, () => {
      const mail = renderWelcomeEmail({
        firstName: 'Maya',
        email: 'maya@example.com',
        origin: 'https://orbit.example.com',
        signIn,
        managedRunner,
      });
      assert.equal(mail.subject, 'Welcome to Orbit, Maya');
      matchSnapshot(`${name}.html`, mail.html);
      matchSnapshot(`${name}.txt`, mail.text);
    });
  }
}

test('the sign-in line says what the design says, per variant', () => {
  const line = (signIn: WelcomeSignIn) =>
    renderWelcomeEmail({ firstName: 'Maya', email: 'maya@example.com', origin: 'https://o.example', signIn, managedRunner: true }).text;
  assert.match(line(SIGN_INS.google), /Sign in with Google, using that same address\./);
  assert.match(line(SIGN_INS['admin-password']), /Alex Rivera added you to Orbit\. Sign in with this email address and the password Alex Rivera gave you\./);
  assert.match(line(SIGN_INS['admin-passwordless']), /Alex Rivera added you to Orbit\. Sign in with Google, using this address\./);
});

test('step 1 follows the managed runner', () => {
  const render = (managedRunner: boolean) =>
    renderWelcomeEmail({ firstName: 'M', email: 'm@x.example', origin: 'https://o.example', signIn: SIGN_INS.google, managedRunner });
  assert.match(render(true).text, /1\. Your runner is being prepared/);
  assert.doesNotMatch(render(true).text, /Connect a computer/);
  assert.match(render(false).text, /1\. Connect a computer\n {3}Install the runner from Settings → Runners\./);
});

test('every interpolated value is escaped in the HTML', () => {
  const evil = '<script>alert("x")</script>&\'';
  const mail = renderWelcomeEmail({
    firstName: evil,
    email: `a${evil}@x.example`,
    origin: 'https://o.example/"><img src=x>',
    signIn: { kind: 'ADMIN_PASSWORD', admin: evil },
    managedRunner: false,
  });
  assert.doesNotMatch(mail.html, /<script>/);
  assert.doesNotMatch(mail.html, /<img src=x>/);
  assert.ok(mail.html.includes(escapeHtml(evil)));
});

test('the only link is the origin, and nothing secret is in the body', () => {
  const mail = renderWelcomeEmail({
    firstName: 'Maya',
    email: 'maya@example.com',
    origin: 'https://orbit.example.com/',
    signIn: SIGN_INS['admin-password'],
    managedRunner: true,
  });
  const hrefs = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 2, 'the host in the first line, and Open Orbit');
  for (const href of hrefs) assert.equal(href, 'https://orbit.example.com');
  assert.doesNotMatch(mail.html + mail.text, /\/dl|Get the apps/);
  assert.doesNotMatch(mail.html + mail.text, /token|password:|magic/i);
  assert.doesNotMatch(mail.html, /<img/);
});

test('first name: the first word of the name, else the email before the @', () => {
  assert.equal(firstNameOf('Maya Chen', 'maya@example.com'), 'Maya');
  assert.equal(firstNameOf('  ', 'jordan@example.org'), 'jordan');
  assert.equal(firstNameOf(null, 'jordan@example.org'), 'jordan');
});
