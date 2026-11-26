import { useState, type ReactNode } from 'react';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { MenuItem } from './ui/Menu';
import { Tooltip } from './ui/Tooltip';
import type { SessionTagRef } from '../lib/sessionGrouping';
import { createSessionTag, recentSessionTagIds } from '../lib/sessionTags';

/** How many tags Recent shows; the rest are a search or All N tags… away. */
const SHOWN = 5;

interface Props {
  library: SessionTagRef[];
  selectedIds: string[];
  saving: boolean;
  onToggle: (id: string) => void;
  /** A tag Create "…" just added to the library, to put on the session at once. */
  onCreated: (tag: SessionTagRef) => void;
}

/**
 * The session menu's Tags level (docs/mocks/session-header-menu): a search field over the tags, the
 * session's own tags, the five used last, every tag one level down, and the seven colour tags as a row of
 * swatches under them — so the menu is as tall however large the library grows. A search names every tag
 * that matches and offers to create the name when none is it.
 */
export function useSessionTagLevel({ library, selectedIds, saving, onToggle, onCreated }: Props): {
  children: MenuItem[];
  levelHeader: ReactNode;
  levelFooter: ReactNode;
} {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = new Set(selectedIds);
  const colours = library.filter((t) => t.isSystem);
  const named = library.filter((t) => !t.isSystem);

  const row = (t: SessionTagRef, prefix = ''): MenuItem => ({
    key: `${prefix}${t.id}`,
    textValue: t.name,
    disabled: saving,
    checked: selected.has(t.id),
    onCheckedChange: () => onToggle(t.id),
    label: (
      <span className="scope-tag-label">
        <span className="session-section-dot" style={{ background: t.color }} />
        {t.name}
      </span>
    ),
  });

  const create = async (name: string) => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      // A new tag takes the next colour round the seven, as the library's own order does.
      const palette = colours.map((t) => t.color);
      const color = palette.length > 0 ? palette[named.length % palette.length] : '#8E8E93';
      const tag = await createSessionTag(name, color);
      setQuery('');
      onCreated(tag);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the tag');
    } finally {
      setCreating(false);
    }
  };

  const typed = query.trim();
  let children: MenuItem[];
  if (typed) {
    const needle = typed.toLowerCase();
    const matches = library.filter((t) => t.name.toLowerCase().includes(needle));
    const exact = library.some((t) => t.name.toLowerCase() === needle);
    children = [
      ...matches.map((t) => row(t)),
      ...(exact
        ? []
        : [{
            key: 'create',
            icon: <PlusOutlined />,
            disabled: creating || saving,
            closeOnSelect: false,
            textValue: `Create ${typed}`,
            label: creating ? 'Creating…' : `Create "${typed}"`,
            onSelect: () => void create(typed),
          }]),
    ];
  } else {
    const onSession = library.filter((t) => selected.has(t.id));
    const recentIds = recentSessionTagIds();
    const recent = recentIds
      .map((id) => named.find((t) => t.id === id))
      .filter((t): t is SessionTagRef => !!t && !selected.has(t.id));
    // Before this browser has tagged anything, the newest tags stand in for Recent.
    const suggested = (recent.length > 0 ? recent : [...named].reverse().filter((t) => !selected.has(t.id))).slice(0, SHOWN);
    children = [
      ...(onSession.length > 0
        ? [{ key: 'on', type: 'group' as const, label: 'On this session', children: onSession.map((t) => row(t, 'on-')) }]
        : []),
      ...(suggested.length > 0
        ? [{ key: 'recent', type: 'group' as const, label: recent.length > 0 ? 'Recent' : 'Newest', children: suggested.map((t) => row(t, 'recent-')) }]
        : []),
      ...(named.length > 0
        ? [
            { key: 'all-divider', type: 'separator' as const },
            { key: 'all', label: `All ${named.length} tags…`, textValue: 'All tags', popupClassName: 'session-tags-all', children: named.map((t) => row(t, 'all-')) },
          ]
        : []),
    ];
  }

  const levelHeader = (
    <div className="session-tags-search">
      <SearchOutlined aria-hidden />
      <input
        aria-label="Search or create a tag"
        placeholder="Search or create a tag"
        value={query}
        maxLength={40}
        onChange={(e) => {
          setQuery(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.key !== 'Enter') return;
          e.preventDefault();
          const needle = typed.toLowerCase();
          const hit = library.find((t) => t.name.toLowerCase() === needle);
          if (hit) {
            onToggle(hit.id);
            setQuery('');
          } else if (typed) void create(typed);
        }}
      />
    </div>
  );

  const levelFooter = (
    <>
      {error && <div className="session-tags-error" role="alert">{error}</div>}
      {colours.length > 0 && !typed && (
        <div className="session-tags-colours" role="group" aria-label="Colors">
          <span className="session-tags-colours-label">Colors</span>
          {colours.map((t) => (
            <Tooltip key={t.id} content={t.name}>
              <button
                type="button"
                className="session-tags-swatch"
                style={{ background: t.color }}
                aria-label={t.name}
                aria-pressed={selected.has(t.id)}
                disabled={saving}
                onClick={() => onToggle(t.id)}
              />
            </Tooltip>
          ))}
        </div>
      )}
    </>
  );

  return { children, levelHeader, levelFooter };
}

/** The session's tags at the end of the header's subtitle: three chips and a "+N", or one "# N" on a phone. */
export function SessionTagChips({ tags, compact, onOpen }: { tags: SessionTagRef[]; compact: boolean; onOpen: () => void }) {
  if (tags.length === 0) return null;
  const label = `Tags: ${tags.map((t) => t.name).join(', ')}`;
  if (compact) {
    return (
      <button type="button" className="session-head-tags" aria-label={label} title={label} onClick={onOpen}>
        <span className="session-head-tag"># {tags.length}</span>
      </button>
    );
  }
  const shown = tags.slice(0, 3);
  return (
    <button type="button" className="session-head-tags" aria-label={label} title={label} onClick={onOpen}>
      {shown.map((t) => (
        <span key={t.id} className="session-head-tag">
          <span className="session-section-dot" style={{ background: t.color }} />
          {t.name}
        </span>
      ))}
      {tags.length > shown.length && <span className="session-head-tag is-more">+{tags.length - shown.length}</span>}
    </button>
  );
}
