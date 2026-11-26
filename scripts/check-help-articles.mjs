// Checks the in-product help articles in docs/help (design: docs/mocks/help-center, board 03).
// Every article is docs/help/<category>/<slug>.md and opens with front matter in the board's format.
// English is the source. A translated copy is docs/help/<language>/<category>/<slug>.md and carries only its title,
// summary and body; the other fields are the English article's, so the two cannot disagree about them.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATEGORIES = [
  'get-started', 'workspaces-and-sessions', 'projects-and-tasks', 'wiki', 'machines-and-engines',
  'models-keys-and-accounts', 'phone-and-desktop-apps', 'integrations-and-api', 'admin-and-self-hosting',
];
export const PLATFORMS = ['web', 'macos', 'ios', 'android'];
export const FIELDS = ['title', 'summary', 'category', 'routes', 'errors', 'platforms', 'common', 'updated'];
export const MIN_ARTICLES = 28;
/** The languages that ship a translated copy of the library, as HELP_LANGUAGES names them (English is the source). */
export const LANGUAGES = ['zh-Hans'];
/** What a translated copy's front matter may hold: the words that change. */
export const TRANSLATED_FIELDS = ['title', 'summary'];

// The board's front matter is flat: `key: value`, where a value is a scalar or an inline `[a, b]` list.
export function parseFrontMatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const pair = line.match(/^([a-z]+):\s*(.*)$/);
    if (!pair) throw new Error(`unreadable front matter line: ${line}`);
    const raw = pair[2].trim();
    fields[pair[1]] = raw.startsWith('[')
      ? (raw.endsWith(']') ? raw.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean) : raw)
      : raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return { fields, body: source.slice(match[0].length) };
}

export function checkArticle(file, source) {
  const errors = [];
  const fail = (message) => errors.push(`${file}: ${message}`);
  let parsed;
  try {
    parsed = parseFrontMatter(source);
  } catch (error) {
    return [`${file}: ${error.message}`];
  }
  if (!parsed) return [`${file}: no front matter (the file must start with a --- block)`];
  const { fields, body } = parsed;
  for (const field of FIELDS) if (!(field in fields)) fail(`missing field: ${field}`);
  for (const field of Object.keys(fields)) if (!FIELDS.includes(field)) fail(`unknown field: ${field}`);
  for (const field of ['title', 'summary']) {
    if (field in fields && (typeof fields[field] !== 'string' || !fields[field])) fail(`${field} must be non-empty text`);
  }
  const [category] = file.split('/').slice(-2);
  if ('category' in fields) {
    if (!CATEGORIES.includes(fields.category)) fail(`unknown category: ${fields.category}`);
    else if (fields.category !== category) fail(`category ${fields.category} does not match its folder ${category}`);
  }
  for (const field of ['routes', 'errors', 'platforms']) {
    if (field in fields && !Array.isArray(fields[field])) fail(`${field} must be a [list]`);
  }
  if (Array.isArray(fields.routes)) {
    for (const route of fields.routes) if (!route.startsWith('/')) fail(`route must start with /: ${route}`);
  }
  if (Array.isArray(fields.errors)) {
    for (const slug of fields.errors) if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(slug)) fail(`bad error slug: ${slug}`);
  }
  if (Array.isArray(fields.platforms)) {
    if (!fields.platforms.length) fail('platforms must name at least one platform');
    for (const platform of fields.platforms) if (!PLATFORMS.includes(platform)) fail(`unknown platform: ${platform}`);
  }
  if ('common' in fields && typeof fields.common !== 'boolean') fail('common must be true or false');
  if ('updated' in fields) {
    const date = String(fields.updated);
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      fail(`updated must be an ISO date (YYYY-MM-DD): ${date}`);
    }
  }
  errors.push(...bodyErrors(file, body));
  // Every word a person reads is English (CLAUDE.md §5); a translated copy is the one place another language lives.
  if (/[㐀-鿿豈-﫿]/.test(source)) fail('contains Chinese text; articles are English');
  return errors;
}

/** The checks a body passes whatever language it is written in: its blocks and its in-app links. */
export function bodyErrors(file, body) {
  const errors = [];
  const fail = (message) => errors.push(`${file}: ${message}`);
  // Platform-only paragraphs: `::: platform ios` ... `:::`, not nested.
  let open = null;
  for (const [index, line] of body.split('\n').entries()) {
    const fence = line.match(/^:::\s*(.*)$/);
    if (!fence) continue;
    if (fence[1]) {
      const [kind, platform] = fence[1].split(/\s+/);
      if (open) fail(`line ${index + 1}: platform block opened inside another`);
      if (kind !== 'platform' || !PLATFORMS.includes(platform)) fail(`line ${index + 1}: unknown block: ${fence[1]}`);
      open = index + 1;
    } else if (!open) {
      fail(`line ${index + 1}: ::: closes no block`);
    } else {
      open = null;
    }
  }
  if (open) fail(`line ${open}: platform block is never closed`);
  for (const link of body.matchAll(/\]\((orbit:[^)\s]*)\)/g)) {
    if (!link[1].startsWith('orbit:/')) fail(`in-app link must be orbit:/path: ${link[1]}`);
  }
  return errors;
}

/**
 * A translated copy: docs/help/<language>/<category>/<slug>.md. Its front matter holds only `title` and `summary`;
 * its category and slug name an English article, whose routes, errors, platforms and date it inherits.
 */
export function checkTranslation(file, source, articles) {
  const errors = [];
  const fail = (message) => errors.push(`${file}: ${message}`);
  let parsed;
  try {
    parsed = parseFrontMatter(source);
  } catch (error) {
    return [`${file}: ${error.message}`];
  }
  if (!parsed) return [`${file}: no front matter (the file must start with a --- block)`];
  const { fields, body } = parsed;
  for (const field of TRANSLATED_FIELDS) {
    if (!(field in fields)) fail(`missing field: ${field}`);
    else if (typeof fields[field] !== 'string' || !fields[field]) fail(`${field} must be non-empty text`);
  }
  for (const field of Object.keys(fields)) {
    if (!TRANSLATED_FIELDS.includes(field)) {
      fail(`${field} belongs to the English article; a translation carries only ${TRANSLATED_FIELDS.join(' and ')}`);
    }
  }
  const parts = file.split('/');
  if (parts.length !== 5) return [`${file}: translations live in docs/help/<language>/<category>/<slug>.md`];
  const [, , , category, name] = parts;
  if (!CATEGORIES.includes(category)) fail(`unknown category: ${category}`);
  if (!body.trim()) fail('body must not be empty');
  const slug = path.basename(name, '.md');
  const english = articles.find((article) => article.file === `docs/help/${category}/${slug}.md`);
  if (!english) fail(`no English article named ${category}/${slug}`);
  errors.push(...bodyErrors(file, body));
  for (const link of source.matchAll(/\]\(orbit:\/help\/([^)\s#]+)\)/g)) {
    if (!articles.some((article) => article.file === `docs/help/${link[1]}.md`)) {
      fail(`link to a missing article: orbit:/help/${link[1]}`);
    }
  }
  return errors;
}

export function checkLibrary(articles) {
  const errors = articles.flatMap(({ file, source }) => checkArticle(file, source));
  if (articles.length < MIN_ARTICLES) errors.push(`docs/help: ${articles.length} articles, fewer than ${MIN_ARTICLES}`);
  const slugs = new Map();
  for (const { file } of articles) {
    const slug = path.basename(file, '.md');
    if (slugs.has(slug)) errors.push(`${file}: slug ${slug} is also used by ${slugs.get(slug)}`);
    slugs.set(slug, file);
  }
  // A link to another article, orbit:/help/<category>/<slug>, must name one that exists.
  for (const { file, source } of articles) {
    for (const link of source.matchAll(/\]\(orbit:\/help\/([^)\s#]+)\)/g)) {
      if (!articles.some((article) => article.file === `docs/help/${link[1]}.md`)) {
        errors.push(`${file}: link to a missing article: orbit:/help/${link[1]}`);
      }
    }
  }
  for (const category of CATEGORIES) {
    if (!articles.some(({ file }) => file.split('/').slice(-2)[0] === category)) {
      errors.push(`docs/help/${category}: no articles`);
    }
  }
  return errors;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const help = path.join(root, 'docs/help');
  const articles = [];
  const translations = [];
  const errors = [];
  for (const entry of readdirSync(help, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.name.endsWith('.md')) {
        errors.push(`docs/help/${entry.name}: articles live in docs/help/<category>/<slug>.md`);
      }
      continue;
    }
    if (LANGUAGES.includes(entry.name)) {
      for (const sub of readdirSync(path.join(help, entry.name), { withFileTypes: true })) {
        if (!sub.isDirectory()) {
          if (sub.name.endsWith('.md')) {
            errors.push(`docs/help/${entry.name}/${sub.name}: translations live in docs/help/<language>/<category>/<slug>.md`);
          }
          continue;
        }
        for (const name of readdirSync(path.join(help, entry.name, sub.name))) {
          if (!name.endsWith('.md')) continue;
          const file = `docs/help/${entry.name}/${sub.name}/${name}`;
          translations.push({ file, source: readFileSync(path.join(root, file), 'utf8') });
        }
      }
    } else if (CATEGORIES.includes(entry.name)) {
      for (const name of readdirSync(path.join(help, entry.name))) {
        if (!name.endsWith('.md')) continue;
        const file = `docs/help/${entry.name}/${name}`;
        articles.push({ file, source: readFileSync(path.join(root, file), 'utf8') });
      }
    } else {
      errors.push(`docs/help/${entry.name}: not a help category or a language`);
    }
  }
  errors.push(...checkLibrary(articles));
  errors.push(...translations.flatMap(({ file, source }) => checkTranslation(file, source, articles)));
  for (const error of errors) console.error(error);
  const common = articles.filter(({ source }) => /^common:\s*true$/m.test(source)).length;
  console.log(
    `Checked ${articles.length} help articles in ${CATEGORIES.length} categories (${common} common) and ` +
      `${translations.length} translations; ${errors.length} errors.`,
  );
  process.exitCode = errors.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
