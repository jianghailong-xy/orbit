import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { HELP_ADMIN_CATEGORY, HELP_CATEGORIES } from '@orbit/shared';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { HELP_LIBRARY_DIR, HelpLibrary, parseArticle, plainText } from './help-library';
import { HelpController, HelpReaderGuard } from './help.controller';

/**
 * The help doors (docs/mocks/help-center board 03): GET /api/help, /api/help/articles/:slug and
 * /api/help/search?q=, over real HTTP through HelpController, HelpReaderGuard and JwtAuthGuard, serving the real
 * library in docs/help — the one the Dockerfile copies into the image — as HelpLibrary.load() reads it at boot.
 */

const ADMIN_ID = randomUUID();
const MEMBER_ID = randomUUID();

const prisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => ({ role: where.id === ADMIN_ID ? 'ADMIN' : 'MEMBER' }),
  },
};

@Module({
  controllers: [HelpController],
  providers: [
    HelpReaderGuard,
    JwtAuthGuard,
    Reflector,
    { provide: HelpLibrary, useFactory: () => HelpLibrary.load() },
    {
      provide: JwtService,
      useValue: {
        verifyAsync: async (token: string) => {
          if (token === 'admin') return { sub: ADMIN_ID, email: 'admin@example.test' };
          if (token === 'member') return { sub: MEMBER_ID, email: 'member@example.test' };
          throw new Error('invalid token');
        },
      },
    },
    { provide: PrismaService, useValue: prisma },
  ],
})
class HelpTestModule {}

async function boot(t: { after: (fn: () => Promise<void>) => void }) {
  const app = await NestFactory.create(HelpTestModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());
  return async (route: string, bearer?: string) => {
    const response = await fetch(`${base}${route}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, json: (await response.json()) as any };
  };
}

const ADMIN_SLUGS = ['email', 'runner-troubleshooting', 'upgrade-orbit', 'users-and-sign-in'];

test('GET /api/help: the categories and every article\'s front matter, without bodies, to a signed-out caller', async (t) => {
  const get = await boot(t);
  const { status, json } = await get('/api/help');
  assert.equal(status, 200);
  assert.deepEqual(
    json.categories.map((c: { slug: string }) => c.slug),
    HELP_CATEGORIES.map((c) => c.slug).filter((slug) => slug !== HELP_ADMIN_CATEGORY),
  );
  assert.equal(json.categories[0].title, 'Get started');
  assert.ok(json.articles.length >= 28, `${json.articles.length} articles`);
  for (const article of json.articles) assert.equal('body' in article, false, `${article.slug} carries its body`);
  assert.deepEqual(json.articles.find((a: { slug: string }) => a.slug === 'machine-offline'), {
    slug: 'machine-offline',
    title: 'A machine shows Offline',
    summary: 'Why it happens, and how to bring it back in under a minute.',
    category: 'machines-and-engines',
    routes: ['/settings/machines/:id', '/infrastructure'],
    errors: ['runner.offline'],
    platforms: ['web', 'macos', 'ios', 'android'],
    common: true,
    updated: '2026-11-14',
  });
});

test('GET /api/help/articles/:slug: an article\'s front matter and Markdown, to a signed-out caller', async (t) => {
  const get = await boot(t);
  const { status, json } = await get('/api/help/articles/machine-offline');
  assert.equal(status, 200);
  assert.equal(json.title, 'A machine shows Offline');
  assert.equal(json.category, 'machines-and-engines');
  assert.match(json.body, /^Orbit marks a machine \*\*Offline\*\*/);
  assert.match(json.body, /```bash\norbit status\n```/);
  const missing = await get('/api/help/articles/no-such-article');
  assert.equal(missing.status, 404);
});

test('GET /api/help?lang=zh-Hans: the same articles, with translated titles and summaries', async (t) => {
  const get = await boot(t);
  const { status, json } = await get('/api/help?lang=zh-Hans');
  assert.equal(status, 200);
  // The categories are the help center's own chrome and stay English.
  assert.equal(json.categories[0].title, 'Get started');
  assert.equal(json.articles.length, (await get('/api/help')).json.articles.length);
  assert.deepEqual(json.articles.find((a: { slug: string }) => a.slug === 'machine-offline'), {
    slug: 'machine-offline',
    title: '机器显示为离线',
    summary: '为什么会这样，以及如何在一分钟内把它恢复。',
    category: 'machines-and-engines',
    routes: ['/settings/machines/:id', '/infrastructure'],
    errors: ['runner.offline'],
    platforms: ['web', 'macos', 'ios', 'android'],
    common: true,
    updated: '2026-11-14',
  });
});

test('GET /api/help/articles/:slug?lang=zh-Hans: the translated prose, the English article\'s other fields', async (t) => {
  const get = await boot(t);
  const { status, json } = await get('/api/help/articles/machine-offline?lang=zh-Hans');
  assert.equal(status, 200);
  assert.equal(json.title, '机器显示为离线');
  assert.equal(json.category, 'machines-and-engines');
  assert.deepEqual(json.routes, ['/settings/machines/:id', '/infrastructure']);
  assert.equal(json.updated, '2026-11-14');
  assert.match(json.body, /Orbit 会把机器标记为 \*\*Offline\*\*/);
  assert.match(json.body, /```bash\norbit status\n```/);
});

test('GET /api/help/search?lang=zh-Hans: a Chinese query finds the Chinese article, a compound query is segmented', async (t) => {
  const get = await boot(t);
  const single = await get(`/api/help/search?q=${encodeURIComponent('离线')}&lang=zh-Hans`);
  assert.equal(single.status, 200);
  const [first] = single.json.hits;
  assert.equal(first.slug, 'machine-offline');
  assert.equal(first.title, '机器显示为离线');
  assert.ok(first.snippet.matches.length > 0);
  // Written without a space: 机器 + 离线, both in the article.
  const compound = await get(`/api/help/search?q=${encodeURIComponent('机器离线')}&lang=zh-Hans`);
  assert.ok(compound.json.hits.some((h: { slug: string }) => h.slug === 'machine-offline'));
});

test('an unknown help language is a 400 at every door', async (t) => {
  const get = await boot(t);
  for (const route of ['/api/help?lang=xx', '/api/help/articles/machine-offline?lang=xx', '/api/help/search?q=offline&lang=xx']) {
    assert.equal((await get(route)).status, 400, route);
  }
});

test('Admin & self-hosting: absent from the index and a 404 to signed-out callers and members, served to admins', async (t) => {
  const get = await boot(t);
  for (const bearer of [undefined, 'member']) {
    const index = await get('/api/help', bearer);
    assert.equal(index.status, 200);
    assert.equal(index.json.categories.some((c: { slug: string }) => c.slug === HELP_ADMIN_CATEGORY), false);
    assert.deepEqual(index.json.articles.filter((a: { category: string }) => a.category === HELP_ADMIN_CATEGORY), []);
    for (const slug of ADMIN_SLUGS) {
      const read = await get(`/api/help/articles/${slug}`, bearer);
      assert.equal(read.status, 404, `${bearer ?? 'signed out'} reads ${slug}`);
      // The same answer as an article that does not exist: nothing says one is there.
      assert.equal(read.json.message, (await get('/api/help/articles/no-such-article', bearer)).json.message);
    }
  }
  const index = await get('/api/help', 'admin');
  assert.equal(index.json.categories.at(-1).slug, HELP_ADMIN_CATEGORY);
  assert.equal(index.json.categories.at(-1).title, 'Admin & self-hosting');
  assert.deepEqual(
    index.json.articles.filter((a: { category: string }) => a.category === HELP_ADMIN_CATEGORY).map((a: { slug: string }) => a.slug).sort(),
    ADMIN_SLUGS,
  );
  const read = await get('/api/help/articles/email', 'admin');
  assert.equal(read.status, 200);
  assert.equal(read.json.title, 'Email');
  assert.match(read.json.body, /Resend/);
});

test('GET /api/help/search?q=offline ranks "A machine shows Offline" first, with offsets to highlight', async (t) => {
  const get = await boot(t);
  const { status, json } = await get('/api/help/search?q=offline');
  assert.equal(status, 200);
  assert.equal(json.query, 'offline');
  const [first] = json.hits;
  assert.equal(first.slug, 'machine-offline');
  assert.equal(first.title, 'A machine shows Offline');
  assert.equal(first.category, 'machines-and-engines');
  assert.deepEqual(first.titleMatches, [{ start: 'A machine shows '.length, length: 'Offline'.length }]);
  assert.ok(first.snippet.matches.length > 0);
  for (const m of first.snippet.matches) {
    assert.equal(first.snippet.text.slice(m.start, m.start + m.length).toLowerCase(), 'offline');
  }
  assert.ok(json.hits.length > 1, 'only the one article says offline');
  for (const hit of json.hits.slice(1)) assert.doesNotMatch(hit.title, /offline/i, `${hit.slug} has a title hit but ranks below`);
  // The same visibility as the index: the runner troubleshooting article says offline, and only an admin finds it.
  assert.equal(json.hits.some((h: { slug: string }) => h.slug === 'runner-troubleshooting'), false);
  assert.equal((await get('/api/help/search?q=offline', 'member')).json.hits.some((h: { slug: string }) => h.slug === 'runner-troubleshooting'), false);
  assert.equal((await get('/api/help/search?q=offline', 'admin')).json.hits.some((h: { slug: string }) => h.slug === 'runner-troubleshooting'), true);
  assert.deepEqual((await get('/api/help/search?q=Resend', 'member')).json.hits, []);
  assert.ok((await get('/api/help/search?q=Resend', 'admin')).json.hits.some((h: { slug: string }) => h.slug === 'email'));
});

test('GET /api/help/search: every word must match, case ignored; an empty query finds nothing', async (t) => {
  const get = await boot(t);
  const both = await get('/api/help/search?q=ORBIT%20status');
  assert.ok(both.json.hits.some((h: { slug: string }) => h.slug === 'machine-offline'));
  assert.deepEqual((await get('/api/help/search?q=offline%20zzzqqq')).json.hits, []);
  assert.deepEqual((await get('/api/help/search?q=%20')).json.hits, []);
  assert.deepEqual((await get('/api/help/search')).json, { query: '', hits: [] });
});

test('a credential that comes with the request is judged: an invalid one is a 401, not a signed-out read', async (t) => {
  const get = await boot(t);
  assert.equal((await get('/api/help', 'not-a-token')).status, 401);
  assert.equal((await get('/api/help/articles/machine-offline', 'not-a-token')).status, 401);
});

test('the library ships with the apiserver: docs/help is where the Dockerfile copies it', () => {
  const root = path.resolve(__dirname, '../../../..');
  assert.equal(HELP_LIBRARY_DIR, path.join(root, 'docs/help'));
  const dockerfile = readFileSync(path.join(root, 'src/apiserver/Dockerfile'), 'utf8');
  // The runtime image's WORKDIR is /app, and dist/help/ is four directories under it, as build/help/ is here.
  assert.match(dockerfile, /^COPY docs\/help \.\/docs\/help$/m);
});

test('a broken article stops the boot rather than serving a library with a hole in it', () => {
  const ok = '---\ntitle: T\nsummary: S\ncategory: wiki\nroutes: [/wiki]\nerrors: []\nplatforms: [web]\ncommon: false\nupdated: 2026-11-14\n---\nBody\n';
  assert.equal(parseArticle('wiki', 'a.md', ok).slug, 'a');
  assert.throws(() => parseArticle('wiki', 'a.md', 'no front matter'), /no front matter/);
  assert.throws(() => parseArticle('wiki', 'a.md', ok.replace('summary: S\n', '')), /missing summary/);
  assert.throws(() => parseArticle('get-started', 'a.md', ok), /not its folder's/);
  assert.throws(() => parseArticle('wiki', 'a.md', ok.replace('[web]', '[web, vax]')), /unknown platform/);
  const a = parseArticle('wiki', 'a.md', ok);
  assert.throws(() => new HelpLibrary([a, { ...a, category: 'get-started' }]), /used twice/);
});

test('a translation takes its prose over the English article, and a missing one falls back to English', () => {
  const ok = '---\ntitle: T\nsummary: S\ncategory: wiki\nroutes: [/wiki]\nerrors: []\nplatforms: [web]\ncommon: false\nupdated: 2026-11-14\n---\nBody\n';
  const other = parseArticle('wiki', 'b.md', ok.replace('title: T', 'title: B'));
  const library = new HelpLibrary([parseArticle('wiki', 'a.md', ok), other]);
  library.addTranslation('zh-Hans', 'wiki', 'a.md', '---\ntitle: 甲\nsummary: 乙\n---\n\n中文正文。\n');
  assert.equal(library.article('a', false, 'zh-Hans')?.title, '甲');
  assert.deepEqual(library.article('a', false, 'zh-Hans')?.routes, ['/wiki']);
  assert.equal(library.article('b', false, 'zh-Hans')?.title, 'B', 'an untranslated article is the English one');
  assert.equal(library.index(false, 'zh-Hans').articles.find((a) => a.slug === 'b')?.title, 'B');
  assert.throws(
    () => library.addTranslation('zh-Hans', 'wiki', 'a.md', '---\ntitle: 甲\nsummary: 乙\n---\nagain\n'),
    /translated twice/,
  );
  assert.throws(
    () => library.addTranslation('zh-Hans', 'wiki', 'gone.md', '---\ntitle: 甲\nsummary: 乙\n---\nx\n'),
    /no English article/,
  );
  assert.throws(
    () => library.addTranslation('zh-Hans', 'get-started', 'a.md', '---\ntitle: 甲\nsummary: 乙\n---\nx\n'),
    /not the article's category/,
  );
  assert.throws(
    () => library.addTranslation('zh-Hans', 'wiki', 'b.md', '---\ntitle: 甲\nsummary: 乙\nroutes: [/wiki]\n---\nx\n'),
    /belongs to the English article/,
  );
});

test('plainText: what a reader sees of the Markdown', () => {
  assert.equal(
    plainText('## Step\n\nRun **this** and [Open it](orbit:/x).\n\n```bash\norbit status\n```\n::: platform ios\n- `Tap` here\n:::\n'),
    'Step Run this and Open it. orbit status Tap here',
  );
  assert.equal(
    plainText('| You see | What to do |\n| --- | :---: |\n| **Runner offline** | See [it](orbit:/help/x), *then* `wait`. |\n\n---\n\nDone.\n'),
    'You see What to do Runner offline See it, then wait. Done.',
  );
});

/** Markdown a snippet must not show: table pipes and separator runs, emphasis, code marks, fences, link targets. */
const MARKDOWN_LEAK = /\||---|\*\*|`|:::|\]\(/;
/** The same, less a lone '|': a shell pipe in a command (`curl … | bash`) is text the reader is meant to see. */
const MARKDOWN_LEAK_BUT_PIPES = /\|\s*\||\|\s*:?-|---|\*\*|`|:::|\]\(/;

test('GET /api/help/search: snippets are plain text, over a table article too, and their offsets slice the query word', async (t) => {
  const get = await boot(t);
  const { json } = await get('/api/help/search?q=offline');
  assert.equal(json.hits[0].slug, 'machine-offline');
  // This article's "offline" sits in a Markdown table, with bold cells and a link in the next column.
  const table = json.hits.find((h: { slug: string }) => h.slug === 'sessions-that-pause-and-resume');
  assert.ok(table, 'the pause-and-resume article is found');
  assert.match(table.snippet.text, /offline/i);
  assert.doesNotMatch(table.snippet.text, MARKDOWN_LEAK);
  for (const q of ['offline', 'quota', 'merge', 'approval', 'orbit status', 'email']) {
    for (const bearer of [undefined, 'admin']) {
      for (const hit of (await get(`/api/help/search?q=${encodeURIComponent(q)}`, bearer)).json.hits) {
        assert.doesNotMatch(hit.snippet.text, MARKDOWN_LEAK_BUT_PIPES, `${q}: ${hit.slug}`);
        for (const m of hit.snippet.matches) {
          assert.ok(q.split(' ').includes(hit.snippet.text.slice(m.start, m.start + m.length).toLowerCase()), `${q}: ${hit.slug}`);
        }
      }
    }
  }
});
