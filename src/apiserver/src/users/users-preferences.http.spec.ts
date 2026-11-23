import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DEFAULT_AGENT_LANGUAGE, TRANSLATION_LANGUAGES } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { resetTranslationBreaker, translate } from '../sessions/translation';
import { UsersController } from './users.controller';

const USER_ID = randomUUID();
let preferences: Record<string, unknown>;
const writes: unknown[] = [];
let baseUrl: string;
const account = () => ({ id: USER_ID, email: 'owner@example.test', preferences, avatar: null, passwordHash: 'scrypt-hash', identities: [] });
/** `GET /users/me`, as every client reads the preferences back. */
const me = () => fetch(`${baseUrl}/users/me`, { headers: { authorization: 'Bearer signed-in' } });

const prisma = {
  user: {
    findUnique: async () => account(),
    update: async (args: { where: unknown; data: { preferences: Record<string, unknown> } }) => {
      writes.push({ where: args.where, data: args.data });
      preferences = args.data.preferences;
      return account();
    },
  },
  // The PATCH reads the row it updates under a lock, inside one transaction (users.controller.ts).
  $queryRaw: async () => [{ preferences }],
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
};

@Module({
  controllers: [UsersController],
  providers: [
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: USER_ID }) } },
    { provide: PrismaService, useValue: prisma },
  ],
})
class PreferencesModule {}

async function boot(t: { after: (fn: () => Promise<void>) => void }) {
  preferences = { theme: 'dark', defaultEffort: 'max', defaultModels: { claude: 'claude-sonnet-5' } };
  writes.length = 0;
  const app = await NestFactory.create(PreferencesModule, { logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  baseUrl = base;
  t.after(() => app.close());
  return (body: unknown, auth = true) => fetch(`${base}/users/me/preferences`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer signed-in' } : {}) },
    body: JSON.stringify(body),
  });
}

test('model preferences update only the picked provider, mirrored under its engine, and round-trip through me', async (t) => {
  const patch = await boot(t);
  const response = await patch({ defaultModels: { codex: 'gpt-6.1-sol' } });
  assert.equal(response.status, 200, await response.clone().text());
  const account = await response.json() as { preferences: unknown };
  // An older client's key is kept as it wrote it, beside the `<engine>:<provider>` key it means
  // (docs/provider-engine-contract.md §6.5).
  assert.deepEqual(account.preferences, {
    theme: 'dark', defaultEffort: 'max',
    defaultModels: { claude: 'claude-sonnet-5', codex: 'gpt-6.1-sol', 'codex:codex': 'gpt-6.1-sol' },
  });
  assert.deepEqual(writes[0], { where: { id: USER_ID }, data: { preferences } });

  const next = await patch({ defaultModels: { codex: 'gpt-5.6-sol', opencode: '' } });
  assert.equal(next.status, 200, await next.text());
  assert.deepEqual(preferences.defaultModels, {
    claude: 'claude-sonnet-5', codex: 'gpt-5.6-sol', 'codex:codex': 'gpt-5.6-sol',
    opencode: '', 'opencode:opencode': '',
  });
  const unrelated = await patch({ defaultEffort: 'ultra' });
  assert.equal(unrelated.status, 200, await unrelated.text());
  assert.equal((preferences.defaultModels as Record<string, string>).codex, 'gpt-5.6-sol');
});

test('the session-recap switch writes only when sent, and absent stays absent', async (t) => {
  const patch = await boot(t);
  // Absent means on (the clients read it that way), so a patch that does not mention it must not
  // write it — that is the whole stored shape of an account that never turned recaps off.
  const unrelated = await patch({ notifyAgentMessage: false });
  assert.equal(unrelated.status, 200, await unrelated.text());
  assert.equal('recaps' in preferences, false);

  const off = await patch({ recaps: false });
  assert.equal(off.status, 200, await off.clone().text());
  const account = await off.json() as { preferences: Record<string, unknown> };
  assert.equal(account.preferences.recaps, false);
  assert.deepEqual(writes.at(-1), { where: { id: USER_ID }, data: { preferences } });

  const malformed = await patch({ recaps: 'off' });
  assert.equal(malformed.status, 400, await malformed.text());
  // The rejected write changed nothing: the account is still opted out.
  assert.equal(preferences.recaps, false);
});

test('cardFreeTaskCreates: a whole number from 0 to 50 persists, absent stays absent, null resets, anything else is refused', async (t) => {
  const patch = await boot(t);
  const unrelated = await patch({ recaps: true });
  assert.equal(unrelated.status, 200, await unrelated.text());
  assert.equal('cardFreeTaskCreates' in preferences, false);

  for (const value of [0, 12, 50]) {
    const ok = await patch({ cardFreeTaskCreates: value });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(((await ok.json()) as { preferences: Record<string, unknown> }).preferences.cardFreeTaskCreates, value);
  }
  for (const value of [-1, 51, 2.5, '8']) {
    const refused = await patch({ cardFreeTaskCreates: value });
    assert.equal(refused.status, 400, `${JSON.stringify(value)}: ${await refused.text()}`);
  }
  // The refused writes changed nothing.
  assert.equal(preferences.cardFreeTaskCreates, 50);

  // null is back to the default: the key goes.
  const reset = await patch({ cardFreeTaskCreates: null });
  assert.equal(reset.status, 200, await reset.text());
  assert.equal('cardFreeTaskCreates' in preferences, false);
});

test('model preferences reject malformed maps and unauthenticated writes', async (t) => {
  const patch = await boot(t);
  for (const defaultModels of ['gpt-6.1-sol', ['gpt-6.1-sol'], { codex: 42 }, { codex: { model: 'gpt-6.1-sol' } }]) {
    const response = await patch({ defaultModels });
    assert.equal(response.status, 400, await response.text());
  }
  const anonymous = await patch({ defaultModels: { codex: 'gpt-6.1-sol' } }, false);
  assert.equal(anonymous.status, 401, await anonymous.text());
  assert.deepEqual(writes, []);
});

test('Settings › Translation: the switch and the language persist, absent stays off, and a language outside the list is refused', async (t) => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const patch = await boot(t);
  // Absent means off: a patch that does not mention it writes nothing.
  const unrelated = await patch({ theme: 'light' });
  assert.equal(unrelated.status, 200, await unrelated.clone().text());
  assert.equal('translationEnabled' in preferences, false);
  assert.equal((await unrelated.json() as { translationAvailable: boolean }).translationAvailable, true);

  const on = await patch({ translationEnabled: true, translationLanguage: 'ja' });
  assert.equal(on.status, 200, await on.clone().text());
  const account = await on.json() as { preferences: Record<string, unknown> };
  assert.equal(account.preferences.translationEnabled, true);
  assert.equal(account.preferences.translationLanguage, 'ja');
  assert.deepEqual(writes.at(-1), { where: { id: USER_ID }, data: { preferences } });

  for (const translationLanguage of ['xx', 'zh', 'zh-CN', 'english', 42]) {
    const refused = await patch({ translationLanguage });
    assert.equal(refused.status, 400, await refused.text());
  }
  const malformed = await patch({ translationEnabled: 'yes' });
  assert.equal(malformed.status, 400, await malformed.text());
  assert.equal(preferences.translationLanguage, 'ja', 'a refused write changed nothing');
  // The other preferences stood throughout.
  assert.equal(preferences.theme, 'light');
});

test('Show both languages: one account preference, off when absent, read back by every client through me', async (t) => {
  const patch = await boot(t);
  const base = (await patch({ theme: 'light' })).url.replace(/\/users\/me\/preferences$/, '');
  // Another client (an iPhone, an Android phone) reads the account through GET /users/me.
  const me = async () => {
    const response = await fetch(`${base}/users/me`, { headers: { authorization: 'Bearer signed-in' } });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { preferences: Record<string, unknown> }).preferences;
  };
  assert.equal('translationBilingual' in (await me()), false, 'absent until written: off');

  const on = await patch({ translationBilingual: true });
  assert.equal(on.status, 200, await on.clone().text());
  assert.equal((await on.json() as { preferences: Record<string, unknown> }).preferences.translationBilingual, true);
  assert.deepEqual(writes.at(-1), { where: { id: USER_ID }, data: { preferences } });
  assert.equal((await me()).translationBilingual, true, 'the web turned it on: the other clients read it on');

  // Writing the other translation keys leaves it alone.
  await patch({ translationEnabled: true, translationLanguage: 'ko', translationAgentLanguage: 'ja' });
  assert.equal((await me()).translationBilingual, true);

  const malformed = await patch({ translationBilingual: 'yes' });
  assert.equal(malformed.status, 400, await malformed.text());
  assert.equal(preferences.translationBilingual, true, 'a refused write changed nothing');

  const off = await patch({ translationBilingual: false });
  assert.equal(off.status, 200, await off.text());
  assert.equal((await me()).translationBilingual, false, 'a phone turned it off: the web reads it off');
  assert.equal(preferences.translationLanguage, 'ko');
});

test('Settings › Translation: the agent language comes from the same list, persists, reads back on me, absent is English, and an unknown code is refused', async (t) => {
  const patch = await boot(t);
  // One list for both pickers: English and the seven shipped codes are all in it.
  for (const code of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de']) {
    assert.ok((TRANSLATION_LANGUAGES as readonly string[]).includes(code), code);
  }
  assert.ok(TRANSLATION_LANGUAGES.length >= 25 && TRANSLATION_LANGUAGES.length <= 35, String(TRANSLATION_LANGUAGES.length));

  // Absent reads as English: an account that never chose one has no key, and the default is 'en'.
  const before = await me();
  assert.equal(before.status, 200, await before.clone().text());
  const fresh = await before.json() as { preferences: Record<string, unknown> };
  assert.equal('translationAgentLanguage' in fresh.preferences, false);
  assert.equal(DEFAULT_AGENT_LANGUAGE, 'en');

  // Accepted and persisted: a non-English agent language, and the owner's language beside it.
  const set = await patch({ translationAgentLanguage: 'ru', translationLanguage: 'en' });
  assert.equal(set.status, 200, await set.clone().text());
  assert.equal((await set.json() as { preferences: Record<string, unknown> }).preferences.translationAgentLanguage, 'ru');
  assert.deepEqual(writes.at(-1), { where: { id: USER_ID }, data: { preferences } });
  assert.equal(preferences.translationAgentLanguage, 'ru');
  assert.equal(preferences.translationLanguage, 'en');
  // The same language on both sides is allowed (the server skips translating that pair).
  const same = await patch({ translationAgentLanguage: 'en' });
  assert.equal(same.status, 200, await same.clone().text());
  const again = await patch({ translationAgentLanguage: 'ru' });
  assert.equal(again.status, 200, await again.clone().text());

  // Read back on me.
  const after = await me();
  assert.equal(after.status, 200, await after.clone().text());
  const read = await after.json() as { preferences: Record<string, unknown> };
  assert.equal(read.preferences.translationAgentLanguage, 'ru');
  assert.equal(read.preferences.theme, 'dark', 'the other preferences stood');

  // Anything outside the list is a 400 and changes nothing.
  const writesBefore = writes.length;
  for (const translationAgentLanguage of ['xx', 'english', 'ru-RU', 'zh', '', 7]) {
    const refused = await patch({ translationAgentLanguage });
    assert.equal(refused.status, 400, `${JSON.stringify(translationAgentLanguage)}: ${await refused.text()}`);
  }
  assert.equal(writes.length, writesBefore, 'a refused write wrote nothing');
  assert.equal(preferences.translationAgentLanguage, 'ru');
});

test('me says whether the server can translate: without DEEPSEEK_API_KEY it cannot', async (t) => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });
  delete process.env.DEEPSEEK_API_KEY;
  const patch = await boot(t);
  const response = await patch({ translationEnabled: true });
  assert.equal(response.status, 200, await response.clone().text());
  const account = await response.json() as { translationAvailable: boolean; preferences: Record<string, unknown> };
  assert.equal(account.translationAvailable, false);
  // The preference is kept as chosen; it simply does nothing until the server has a key.
  assert.equal(account.preferences.translationEnabled, true);
});

test('GET /users/me reports translationUnavailableUntil while the translator breaker is open, and null after its 60 s', async (t) => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    mock.timers.reset();
    resetTranslationBreaker();
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });
  process.env.DEEPSEEK_API_KEY = 'test-key';
  resetTranslationBreaker();
  await boot(t);
  const closed = await (await me()).json() as { translationUnavailableUntil: string | null };
  assert.equal(closed.translationUnavailableUntil, null);

  // Three unreachable translations (each after its retries, the clock stepped past their pauses) open it.
  const opened = Date.now();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: opened });
  globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  for (let i = 0; i < 3; i++) {
    let done = false;
    translate('你好', 'zh-Hans', 'en').catch(() => undefined).finally(() => { done = true; });
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!done) mock.timers.tick(250);
    }
  }
  const until = Date.now() + 60_000;
  mock.timers.reset();
  globalThis.fetch = realFetch;

  const open = await (await me()).json() as { translationUnavailableUntil: string | null };
  assert.equal(open.translationUnavailableUntil, new Date(until).toISOString());

  mock.timers.enable({ apis: ['Date'], now: until });
  const after = await (await me()).json() as { translationUnavailableUntil: string | null };
  assert.equal(after.translationUnavailableUntil, null);
});
