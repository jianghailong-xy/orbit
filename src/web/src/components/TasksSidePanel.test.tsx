import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

// TasksSidePanel itself reaches for localStorage, several polled queries and an SSE hook on
// mount, none of which exist in this Node test environment — so instead of mounting it, this
// asserts directly on the source for the two contract points TOP (not exported) drives: the
// fixed nav array both surfaces render from, and the `sel === t.key` highlight it feeds.
const source = readFileSync(fileURLToPath(new URL('./TasksSidePanel.tsx', import.meta.url)), 'utf8');

describe('TasksSidePanel nav', () => {
  it('adds a Projects entry (icon + label) to the fixed TOP nav', () => {
    const topBlock = source.match(/const TOP = \[([\s\S]*?)\n\];/)?.[1] ?? '';
    expect(topBlock).toMatch(/\{\s*key:\s*'projects',\s*icon:\s*<ProjectOutlined\s*\/>,\s*label:\s*'Projects'\s*,?\s*\}/);
  });

  it('renders TOP-derived items in both the collapsed rail and the expanded nav', () => {
    // The rail maps TOP directly; the expanded section maps navItems, which starts from TOP —
    // so a TOP entry reaches both surfaces without either render site needing its own list.
    expect(source).toMatch(/const navItems =\s*\n?\s*me\.data\?\.role === 'ADMIN'\s*\n?\s*\?\s*\[\.\.\.TOP,/);
    expect(source).toContain('{TOP.map((t) => (');
    expect(source).toContain('{navItems.map((t) => (');
  });

  it('highlights the matching TOP item by sel === t.key in both surfaces', () => {
    expect(source).toContain("`tp-rail-item ${sel === t.key ? 'active' : ''}`");
    expect(source).toContain("`tp-item ${sel === t.key ? 'active' : ''}`");
  });

  it('still falls back to pathname.slice(1) for sel — /projects resolves via this untouched branch', () => {
    // Guards against a sidebar-selection refactor: /projects matches none of the special-cased
    // prefixes (/workspaces/, /sessions/, /runner, /lists/), so it must keep landing here to
    // produce sel === 'projects' and light up the entry asserted above.
    expect(source).toContain(': loc.pathname.slice(1);');
  });

  it('keeps Projects selected on a project detail URL', () => {
    // /projects/<id> would otherwise reach the slice(1) fallback above and produce
    // sel === 'projects/<id>', which matches no TOP key — the entry would go dark on the very
    // page you navigated to from it. This branch has to map the whole subtree back to 'projects'.
    expect(source).toMatch(/startsWith\('\/projects\/'\)\s*\n?\s*\?\s*'projects'/);
    // The runner branch is checked first and its /runner prefix must not swallow it.
    expect(source).not.toMatch(/startsWith\('\/project'\)/);
  });
});
