import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

// WorkspaceView mounts localStorage, a dozen queries and an SSE hook, none of which exist in this
// Node test environment — so, as with TasksSidePanel, the group-capping contract is asserted on
// the source. What each group renders is `projectActiveFace`'s (tested in lib/projectGrouping);
// what is left to check here is that the list actually asks it, and that "view all" is a look
// rather than a setting.
const source = readFileSync(fileURLToPath(new URL('./WorkspaceView.tsx', import.meta.url)), 'utf8');

describe('project group capping', () => {
  it('renders a project group through the shared active face, and its label with it', () => {
    expect(source).toMatch(/import \{[\s\S]*?projectActiveFace,[\s\S]*?\} from '\.\.\/lib\/projectGrouping';/);
    expect(source).toContain('const face = projectActiveFace(rows);');
    expect(source).toContain('label: expanded ? \'Show less\' : projectFoldLabel(face),');
  });

  it('shows the whole group once expanded, and only the face until then', () => {
    expect(source).toContain('sessions: expanded ? rows : face.visible,');
  });

  it('drops the fold line when the group is already whole', () => {
    // Nothing hidden, nothing to offer — a "View all 3" under three rows is a dead control.
    expect(source).toContain('face.hiddenCount === 0');
  });

  it('caps projects only — Pinned and Unfiled keep every row', () => {
    // The cap sits behind the projectId check, so the two group kinds that are not projects
    // fall through to the sections map below it.
    expect(source).toMatch(/if \(g\.projectId !== null\) \{\s*\n\s*const rows = g\.sections\[0\]\.sessions;/);
  });

  it('keeps the expanded set in component state, unlike the persisted collapse set', () => {
    expect(source).toContain(
      'const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set<string>());',
    );
    // Only the roll-up state is written to localStorage; expansion is not stored anywhere.
    expect(source).toContain(
      'localStorage.setItem(SESSION_GROUP_COLLAPSED_KEY, JSON.stringify([...collapsedGroups]));',
    );
    expect(source).not.toMatch(/localStorage\.[gs]etItem\([^)]*expanded/i);
  });
});
