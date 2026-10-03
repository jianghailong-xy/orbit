import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import GithubSlugger from 'github-slugger';
import MarkdownIt from 'markdown-it';
import markdownLinkCheck from 'markdown-link-check';

const markdown = new MarkdownIt({ html: true });
const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function publicFiles(tracked, guides) {
  return tracked.filter((file) => file.endsWith('.md') && (
    (!file.includes('/') && !['AGENTS.md', 'CLAUDE.md'].includes(file)) ||
    file.startsWith('.github/') || guides.includes(file)
  ));
}

function anchorsFor(source, isMarkdown) {
  const anchors = new Set();
  const html = isMarkdown ? markdown.render(source) : source;
  for (const pattern of [/<[^>]*\sid=["']([^"']+)["']/gi, /<a\b[^>]*\sname=["']([^"']+)["']/gi]) {
    for (const match of html.matchAll(pattern)) anchors.add(match[1]);
  }
  if (isMarkdown) {
    const slugger = new GithubSlugger();
    const tokens = markdown.parse(source, {});
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'heading_open') continue;
      const rendered = markdown.renderer.renderInline(tokens[i + 1].children, markdown.options, {});
      const title = markdown.utils.unescapeAll(rendered.replace(/<[^>]*>/g, ''));
      anchors.add(slugger.slug(title));
    }
  }
  return anchors;
}

export async function checkLocalLinks(file, source, root, tracked, config) {
  const base = pathToFileURL(`${path.dirname(path.join(root, file))}${path.sep}`).href;
  // Keep CI deterministic and credential-free: only repository links are checked.
  // Fragment validation below handles GitHub slugs across files and Setext headings.
  const results = await new Promise((resolve, reject) => markdownLinkCheck(source, {
    ...config,
    baseUrl: base,
    ignoreDisable: true,
    ignorePatterns: [...(config.ignorePatterns || []), { pattern: external }, { pattern: '^#' }],
  }, (error, links) => error ? reject(error) : resolve(links)));
  const errors = [];
  for (const result of results) {
    if (external.test(result.link)) continue;
    const url = new URL(result.link, pathToFileURL(path.join(root, file)));
    const target = fileURLToPath(url);
    const relative = path.relative(root, target).split(path.sep).join('/');
    const inRepository = tracked.has(relative) || [...tracked].some((name) => name.startsWith(`${relative}/`));
    if (!inRepository || result.status === 'dead' || result.status === 'error') {
      errors.push(`${file}: missing tracked local target: ${result.link}`);
      continue;
    }
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (!fragment) continue;
    let anchorTarget = target;
    if (statSync(target).isDirectory()) anchorTarget = path.join(target, 'README.md');
    if (!tracked.has(path.relative(root, anchorTarget).split(path.sep).join('/'))) {
      errors.push(`${file}: missing tracked local target: ${result.link}`);
      continue;
    }
    const contents = readFileSync(anchorTarget, 'utf8');
    const isMarkdown = anchorTarget.endsWith('.md');
    const line = !isMarkdown && fragment.match(/^L(\d+)(?:-L(\d+))?$/);
    const validLine = line && Number(line[1]) > 0 && Number(line[2] || line[1]) >= Number(line[1]) &&
      Number(line[2] || line[1]) <= contents.split('\n').length - Number(contents.endsWith('\n'));
    if (!validLine && !anchorsFor(contents, isMarkdown).has(fragment)) {
      errors.push(`${file}: missing local anchor: ${result.link}`);
    }
  }
  return errors;
}

async function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.chdir(root);
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const guides = readFileSync('scripts/docs-public-files.txt', 'utf8').trim().split('\n');
  const missing = guides.filter((file) => !tracked.includes(file));
  if (missing.length) throw new Error(`Public guides must be tracked: ${missing.join(', ')}`);
  const files = publicFiles(tracked, guides);
  const lintBin = path.join(path.dirname(fileURLToPath(import.meta.resolve('markdownlint-cli2'))), 'markdownlint-cli2-bin.mjs');
  const lint = spawnSync(process.execPath, [lintBin, '--config', '.markdownlint-cli2.jsonc', ...files], { stdio: 'inherit' });
  const config = JSON.parse(readFileSync('.markdown-link-check.json', 'utf8'));
  const errors = [];
  const trackedSet = new Set(tracked);
  for (const file of files) {
    errors.push(...await checkLocalLinks(file, readFileSync(file, 'utf8'), root, trackedSet, config));
  }
  for (const error of errors) console.error(error);
  console.log(`Checked ${files.length} public Markdown files; ${errors.length} local link/anchor errors.`);
  process.exitCode = lint.status === 0 && errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
