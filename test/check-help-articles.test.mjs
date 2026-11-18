import assert from 'node:assert/strict';
import test from 'node:test';
import { CATEGORIES, checkArticle, checkLibrary, parseFrontMatter } from '../scripts/check-help-articles.mjs';

const article = (fields = {}, body = 'Body.\n') => {
  const all = {
    title: 'A machine shows Offline', summary: 'Why it happens.', category: 'machines-and-engines',
    routes: '[/settings/machines/:id, /infrastructure]', errors: '[runner.offline]', platforms: '[web, ios]',
    common: 'true', updated: '2026-11-14', ...fields,
  };
  const lines = Object.entries(all).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
};
const file = 'docs/help/machines-and-engines/machine-offline.md';

test('front matter parses scalars, booleans and inline lists', () => {
  assert.deepEqual(parseFrontMatter(article()).fields, {
    title: 'A machine shows Offline', summary: 'Why it happens.', category: 'machines-and-engines',
    routes: ['/settings/machines/:id', '/infrastructure'], errors: ['runner.offline'], platforms: ['web', 'ios'],
    common: true, updated: '2026-11-14',
  });
  assert.deepEqual(parseFrontMatter(article({ errors: '[]' })).fields.errors, []);
});

test('a complete article passes', () => {
  assert.deepEqual(checkArticle(file, article({}, '[Open it](orbit:/settings/machines/:id)\n\n::: platform ios\nOnly iPhone.\n:::\n')), []);
});

test('missing fields, unknown categories and platforms, and bad values fail', () => {
  assert.match(checkArticle(file, article({ errors: undefined }))[0], /missing field: errors/);
  assert.match(checkArticle(file, 'No front matter\n')[0], /no front matter/);
  assert.match(checkArticle(file, article({ category: 'billing' })).join(), /unknown category: billing/);
  assert.match(checkArticle(file, article({ category: 'wiki' })).join(), /does not match its folder/);
  assert.match(checkArticle(file, article({ platforms: '[web, windows]' })).join(), /unknown platform: windows/);
  assert.match(checkArticle(file, article({ common: 'yes' })).join(), /common must be true or false/);
  assert.match(checkArticle(file, article({ updated: '2026-13-01' })).join(), /ISO date/);
  assert.match(checkArticle(file, article({}, '::: platform ios\nNever closed.\n')).join(), /never closed/);
  assert.match(checkArticle(file, article({}, '[Open](orbit:settings)\n')).join(), /orbit:\/path/);
  assert.match(checkArticle(file, article({ title: String.fromCodePoint(0x673a, 0x5668) })).join(), /English/);
});

test('the library needs 28 articles, every category, and unique slugs', () => {
  const one = (category, slug) => ({ file: `docs/help/${category}/${slug}.md`, source: article({ category }) });
  const full = Array.from({ length: 28 }, (_, i) => one(CATEGORIES[i % CATEGORIES.length], `a${i}`));
  assert.deepEqual(checkLibrary(full), []);
  assert.match(checkLibrary(full.slice(0, 27)).join(), /27 articles, fewer than 28/);
  assert.match(checkLibrary(full.filter(({ file: name }) => !name.includes('/wiki/'))).join(), /docs\/help\/wiki: no articles/);
  assert.match(checkLibrary([...full, one('wiki', 'a0')]).join(), /slug a0 is also used/);
  const linking = { file: 'docs/help/wiki/linking.md', source: article({ category: 'wiki' }, '[A](orbit:/help/wiki/a3) [B](orbit:/help/wiki/gone)\n') };
  assert.deepEqual(checkLibrary([...full, linking]), ['docs/help/wiki/linking.md: link to a missing article: orbit:/help/wiki/gone']);
});
