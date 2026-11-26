import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * A clickable list row shows keyboard focus as its hover tint, never the browser's blue ring: Chrome draws
 * :focus-visible after a click followed by any key press, so the ring shows up as a stray border round the row
 * the mouse picked. That was fixed list by list (project rows 5a4653af6, session rows 24b5c3c53) and came back on
 * the next list built (the schedule rows). So the rule lives once, on [data-row-focus] in components/ui/root.css,
 * and this test reads every component: a focusable element (a button, a link, or tabIndex 0) whose first class
 * names a row or an item must carry data-row-focus, unless a stylesheet gives that class a :focus rule of its own.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '__fixtures__']);
const ROW = /(^|-)(row|item)$/;

function walkDir(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkDir(full, keep, out);
    } else if (keep(entry.name)) out.push(full);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function attr(el: Node, name: string): Node | undefined {
  return el.attributes.find((a: Node) => a.type === 'JSXAttribute' && a.name?.name === name);
}

function focusable(el: Node): boolean {
  const name = el.name?.name;
  if (name === 'button') return true;
  if (name === 'a') return !!attr(el, 'href');
  if (name === 'Link' || name === 'NavLink') return true;
  const tab = attr(el, 'tabIndex')?.value;
  return tab?.value === '0' || tab?.expression?.value === 0;
}

/** The first class a className names before any expression: "x y", {'x'} or {`x${...}`}. */
function firstClass(el: Node): string {
  const v = attr(el, 'className')?.value;
  let text = '';
  if (v?.type === 'Literal') text = v.value;
  else if (v?.expression?.type === 'Literal') text = String(v.expression.value);
  else if (v?.expression?.type === 'TemplateLiteral') text = v.expression.quasis[0].value.cooked;
  return text.trim().split(/\s+/)[0] ?? '';
}

describe('row focus', () => {
  const css = walkDir(SRC, (n) => n.endsWith('.css')).map((f) => readFileSync(f, 'utf8')).join('\n');

  it('root.css draws a marked row\'s keyboard focus as a tint', () => {
    expect(readFileSync(path.join(SRC, 'components/ui/root.css'), 'utf8'))
      .toMatch(/\[data-row-focus\]:focus-visible \{\s*outline: none;\s*background-color: var\(--bg-hover\);/);
  });

  it('every focusable row is marked or styles its own focus', () => {
    const unmarked: string[] = [];
    for (const file of walkDir(SRC, (n) => n.endsWith('.tsx') && !n.includes('.test.'))) {
      const visit = (node: Node): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (node.type === 'JSXOpeningElement' && focusable(node)) {
          const cls = firstClass(node);
          if (cls && ROW.test(cls) && !cls.startsWith('orbit-') && !attr(node, 'data-row-focus')) {
            const own = new RegExp(`\\.${cls}(?![\\w-])[^{}]*:focus`).test(css);
            if (!own) unmarked.push(`${path.relative(SRC, file)}: .${cls}`);
          }
        }
        for (const key of Object.keys(node)) visit(node[key]);
      };
      visit(parseAst(readFileSync(file, 'utf8'), { lang: 'tsx' }, file));
    }
    expect(unmarked).toEqual([]);
  });
});
