import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inviteTitleOf, ownerNameOf, renderSessionInviteEmail, type SessionInviteEmailInput } from './session-invite-email.template';
import { escapeHtml } from './welcome-email.template';

/**
 * Snapshot tests of the session invitation email (owner decision D7 = A), HTML and plain text, as
 * welcome-email.template.spec.ts does them. `UPDATE_SNAPSHOTS=1 npm test` writes them again; review the diff.
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

const INPUT: SessionInviteEmailInput = {
  ownerName: 'Alex Rivera',
  sessionTitle: 'Fix the flaky login test\nand the CI cache after it',
  guestEmail: 'maya@example.com',
  origin: 'https://orbit.example.com/',
  sessionPublicId: '343dlzsYWKo5z8l2M8tsB',
};

test('session invite email snapshot', () => {
  const mail = renderSessionInviteEmail(INPUT);
  assert.equal(mail.subject, 'Alex Rivera invited you to reply in “Fix the flaky login test”');
  matchSnapshot('session-invite.html', mail.html);
  matchSnapshot('session-invite.txt', mail.text);
});

test('the body, the button, the link line and the sign-in line say what D7 says', () => {
  const mail = renderSessionInviteEmail(INPUT);
  const body = 'Alex Rivera invited you to a conversation on Orbit. You can read it and send messages; they go to Alex Rivera’s agent and run on Alex Rivera’s machine.';
  assert.ok(mail.text.includes(body));
  assert.ok(mail.html.includes(escapeHtml(body)));
  assert.ok(mail.text.includes('Open conversation: https://orbit.example.com/sessions/343dlzsYWKo5z8l2M8tsB'));
  assert.ok(mail.text.includes('Sign in as maya@example.com to open it.'));
  assert.match(mail.html, /href="https:\/\/orbit\.example\.com\/sessions\/343dlzsYWKo5z8l2M8tsB"[^>]*>Open conversation<\/a>/);
  assert.match(mail.html, />Or open <a [^>]*>orbit\.example\.com\/sessions\/343dlzsYWKo5z8l2M8tsB<\/a>/);
  assert.ok(mail.html.includes('Sign in as maya@example.com to open it.'));
});

test('the only link is the session page, and there are no images', () => {
  const mail = renderSessionInviteEmail(INPUT);
  const hrefs = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 2, 'the button and the Or open line');
  for (const href of hrefs) assert.equal(href, 'https://orbit.example.com/sessions/343dlzsYWKo5z8l2M8tsB');
  assert.doesNotMatch(mail.html, /<img/);
  assert.doesNotMatch(mail.html + mail.text, /and the CI cache/, 'only the first line of the title');
});

test('every interpolated value is escaped in the HTML', () => {
  const evil = '<script>alert("x")</script>&\'';
  const mail = renderSessionInviteEmail({
    ownerName: evil,
    sessionTitle: evil,
    guestEmail: `a${evil}@x.example`,
    origin: 'https://o.example/"><img src=x>',
    sessionPublicId: '"><img src=y>',
  });
  assert.doesNotMatch(mail.html, /<script>/);
  assert.doesNotMatch(mail.html, /<img src=/);
  assert.ok(mail.html.includes(escapeHtml(evil)));
});

test('the title: its first line, else Untitled session; the owner: their name, else their email', () => {
  assert.equal(inviteTitleOf('  One\nTwo'), 'One');
  assert.equal(inviteTitleOf(''), 'Untitled session');
  assert.equal(inviteTitleOf('  \n  second'), 'second', 'leading blank lines are trimmed');
  assert.equal(renderSessionInviteEmail({ ...INPUT, sessionTitle: '' }).subject, 'Alex Rivera invited you to reply in “Untitled session”');
  assert.equal(ownerNameOf({ name: '  Alex Rivera ', email: 'alex@example.com' }), 'Alex Rivera');
  assert.equal(ownerNameOf({ name: '  ', email: 'alex@example.com' }), 'alex@example.com');
  assert.equal(ownerNameOf({ name: null, email: 'alex@example.com' }), 'alex@example.com');
});
