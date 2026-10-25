import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UsersController } from './users.controller';

const USER_ID = randomUUID();
let preferences: Record<string, unknown>;
const writes: unknown[] = [];

@Module({
  controllers: [UsersController],
  providers: [
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: USER_ID }) } },
    { provide: PrismaService, useValue: {
      user: {
        findUnique: async () => ({ preferences }),
        update: async (args: { where: unknown; data: { preferences: Record<string, unknown> } }) => {
          writes.push({ where: args.where, data: args.data });
          preferences = args.data.preferences;
          return { id: USER_ID, email: 'owner@example.test', preferences, avatar: null, passwordHash: 'scrypt-hash', identities: [] };
        },
      },
    } },
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
