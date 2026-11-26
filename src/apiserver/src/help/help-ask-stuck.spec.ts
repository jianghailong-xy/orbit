import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORBIT_RELEASE_REPOSITORY_DEFAULT } from '@orbit/shared';
import { adminTaskDescription, exchangesOf, privateNamesOf, releaseRepository } from './help-ask';

// Still stuck's pure parts (help/help-ask.ts): where a report goes, which names it leaves out, and the admin's task.

test('the release repository: ORBIT_RELEASE_REPOSITORY as owner/repo or its GitHub URL, else Orbit\'s own', () => {
  assert.equal(releaseRepository({}), ORBIT_RELEASE_REPOSITORY_DEFAULT);
  assert.equal(releaseRepository({ ORBIT_RELEASE_REPOSITORY: 'acme/orbit-fork' }), 'acme/orbit-fork');
  assert.equal(releaseRepository({ ORBIT_RELEASE_REPOSITORY: ' https://github.com/acme/orbit-fork.git ' }), 'acme/orbit-fork');
  assert.equal(releaseRepository({ ORBIT_RELEASE_REPOSITORY: 'not a repository' }), ORBIT_RELEASE_REPOSITORY_DEFAULT);
  assert.equal(releaseRepository({ ORBIT_RELEASE_REPOSITORY: 'https://evil.example/x/y' }), ORBIT_RELEASE_REPOSITORY_DEFAULT);
});

test('the names a report leaves out: each workspace, its folder and its repository, longest first', () => {
  const names = privateNamesOf([
    { name: 'payments', workDir: '/srv/billing-worker/', repoUrl: 'git@github.com:acme-corp/payments-api.git' },
    { name: 'ab', workDir: null, repoUrl: 'https://gitlab.com/acme-corp/infra/terraform-live' },
  ]);
  assert.deepEqual(new Set(names), new Set(['payments', 'billing-worker', 'acme-corp/payments-api', 'payments-api', 'infra/terraform-live', 'terraform-live']));
  assert.equal(names[0].length, Math.max(...names.map((n) => n.length)));
  assert.ok(!names.includes('ab'), 'two letters would cut ordinary words');
});

test('the admin\'s task says who is stuck, links the Ask, and holds the question and the answer', () => {
  const text = adminTaskDescription({
    asker: { name: 'Mia', email: 'mia@example.com' },
    link: 'https://orbit.example/help/questions/abc',
    exchanges: [{ question: 'Why is build-box offline?', answer: 'It slept.' }, { question: 'It is awake.', answer: '' }],
  });
  assert.match(text, /^Mia \(mia@example\.com\) asked Orbit's help, is still stuck/u);
  assert.ok(text.includes('Ask: https://orbit.example/help/questions/abc'));
  assert.ok(text.includes('## Question 1\n\nWhy is build-box offline?\n\n## Answer 1\n\nIt slept.'));
  assert.ok(text.includes('## Answer 2\n\n(no answer)'));
});

test('the admin\'s task pairs each question with the answer it got, and a failed one with none', () => {
  const at = '2026-11-26T00:00:00.000Z';
  assert.deepEqual(
    exchangesOf([
      { role: 'user', text: 'Why is build-box offline?', at },
      { role: 'assistant', text: 'It slept.', at },
      { role: 'user', text: 'It is awake.', at },
      { role: 'assistant', text: '', at, error: 'DeepSeek answered 503.' },
    ]),
    [{ question: 'Why is build-box offline?', answer: 'It slept.' }, { question: 'It is awake.', answer: '' }],
  );
});
