#!/usr/bin/env python3
# Applies the board's prototype to <tree>/src/web. Nothing here is the product: it exists to shoot real pages.
import sys, pathlib
tree = pathlib.Path(sys.argv[1]) / 'src/web/src'

def edit(rel, pairs):
    path = tree / rel
    text = path.read_text()
    for old, new in pairs:
        assert text.count(old) == 1, (rel, old[:60], text.count(old))
        text = text.replace(old, new)
    path.write_text(text)

(tree / 'lib/wikiDelete.tsx').write_text('''import type { ReactNode } from 'react';

/** What the Delete wiki dialog says. Prototype for the design board. */
export function wikiDeleteDialog(name: string, repoUrlNorm: string | null | undefined, entries: number | null, documents: number) {
  const parts = [
    entries === null ? 'entries' : `${entries.toLocaleString('en-US')} ${entries === 1 ? 'entry' : 'entries'}`,
    ...(documents > 0 ? [`${documents} ${documents === 1 ? 'document' : 'documents'}`] : []),
  ];
  const description: ReactNode = (
    <>
      Its {parts.join(', ')} and their history will be permanently deleted. This cannot be undone.
      {repoUrlNorm ? (
        <>
          <br /><br />
          The next session on {repoUrlNorm} to use the wiki starts a new, empty one.
        </>
      ) : null}
      <br /><br />
      Workspaces and sessions are kept.
    </>
  );
  return {
    title: `Delete wiki “${name}”?`,
    description,
    confirmText: 'Delete wiki',
    cancelText: 'Cancel',
    danger: true,
  };
}
''')

edit('components/TasksSidePanel.tsx', [
    ("""export function WikiRow({
  name,
  waiting,
  active,
  onOpen,
}: {
  name: string;
  waiting: number;
  active: boolean;
  onOpen: () => void;
}) {
  const waitingOnYou = wikiWaitingOnYou(waiting);
  return (
    <div
      className={`tp-item ${active ? 'active' : ''}`}
      onClick={onOpen}
""", """export function WikiRow({
  name,
  waiting,
  active,
  onOpen,
  menu,
}: {
  name: string;
  waiting: number;
  active: boolean;
  onOpen: () => void;
  menu?: MenuItem[];
}) {
  const waitingOnYou = wikiWaitingOnYou(waiting);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={`tp-item ${active ? 'active' : ''}${menuOpen ? ' menu-open' : ''}`}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
"""),
    ("""        <span className="tp-count needs-you" title={waitingOnYou} aria-label={waitingOnYou}>
          {waiting}
        </span>
      )}
    </div>
""", """        <span className="tp-count needs-you" title={waitingOnYou} aria-label={waitingOnYou}>
          {waiting}
        </span>
      )}
      {menu && (
        <span className="tp-workspace-actions" onClick={(e) => e.stopPropagation()}>
          <Menu
            side="bottom"
            align="end"
            items={menu}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            trigger={
              <button type="button" className="tp-workspace-more" aria-label={`${name} actions`} title="Actions">
                <MoreOutlined />
              </button>
            }
          />
        </span>
      )}
    </div>
"""),
    ("""                    onOpen={() => openWiki(space.slug)}
""", """                    onOpen={() => openWiki(space.slug)}
                    menu={wikiMenu(space)}
"""),
    ("""  // Measured before paint, and again whenever the list or the Workspaces group changes size. With no
""", """  const wikiMenu = (space: (typeof wikiRows)[number]): MenuItem[] => [
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: 'Wiki settings',
      onSelect: () => {
        onNavigate?.();
        navigate(`${wikiSpacePath(space.slug)}/settings`);
      },
    },
    { type: 'separator' as const, key: 'divider' },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: 'Delete wiki…',
      danger: true,
      onSelect: () => {
        const name = wikiNames.get(space.id) ?? space.title;
        void api<{ entries: number }>(`/wiki/spaces/${encodeURIComponent(space.id)}/health`).then((health) =>
          confirm({
            ...wikiDeleteDialog(name, space.repoUrlNorm, health.entries, space.docs?.written ?? 0),
            onConfirm: async () => {
              await api(`/wiki/spaces/${encodeURIComponent(space.id)}`, { method: 'DELETE' });
              if (wikiOnScreen?.id === space.id) navigate('/wiki');
              await qc.invalidateQueries({ queryKey: ['wiki'] });
              message.success(`Deleted wiki “${name}”`);
            },
          }),
        );
      },
    },
  ];
  // Measured before paint, and again whenever the list or the Workspaces group changes size. With no
"""),
    ("""import { useToast } from '../lib/toast';
""", """import { useToast } from '../lib/toast';
import { wikiDeleteDialog } from '../lib/wikiDelete';
"""),
])

edit('components/WikiSettingsPage.tsx', [
    ("""      {setUp && (
        <MaintenanceSetUp
""", """      <WikiDeleteCard space={space} />

      {setUp && (
        <MaintenanceSetUp
"""),
    ("""/**
 * The Workspaces card (mock 38, contract `space.workspaces`)""", """/** Delete wiki, the last thing on the page. Prototype for the design board. */
function WikiDeleteCard({ space }: { space: WikiSpaceRow }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, confirmation] = useConfirm();
  const spaces = useQuery(wikiSpacesQuery());
  const name = wikiSpaceNames(spaces.data ?? []).get(space.id) ?? space.title;
  const ask = async () => {
    const health = await api<{ entries: number }>(`/wiki/spaces/${encodeURIComponent(space.id)}/health`);
    await confirm({
      ...wikiDeleteDialog(name, space.repoUrlNorm, health.entries, space.docs?.written ?? 0),
      onConfirm: async () => {
        await api(`/wiki/spaces/${encodeURIComponent(space.id)}`, { method: 'DELETE' });
        navigate('/wiki');
        await qc.invalidateQueries({ queryKey: ['wiki'] });
        toast.success(`Deleted wiki “${name}”`);
      },
    });
  };
  return (
    <Card className="wk-settings-card wk-delete-card" title="Delete this wiki">
      <div className="wk-delete">
        <div className="wk-maint-d">Its entries, documents and history are permanently deleted.</div>
        <Button danger onClick={() => void ask()}>Delete wiki…</Button>
      </div>
      {confirmation}
    </Card>
  );
}

/**
 * The Workspaces card (mock 38, contract `space.workspaces`)"""),
    ("""import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
""", """import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
"""),
    ("""import { Button } from './ui/Button';
""", """import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';
import { api } from '../api';
import { wikiDeleteDialog } from '../lib/wikiDelete';
import { wikiSpaceNames } from '../lib/wikiSpace';
import { wikiSpacesQuery } from '../lib/queries';
"""),
])

css = tree / 'index.css'
css.write_text(css.read_text() + '''
/* Prototype for the Delete wiki board. */
.wk-delete { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
@media (min-width: 961px) {
  .app-shell .app-nav:not(.collapsed) .tp-item:hover .tp-label ~ .tp-count.needs-you:has(+ .tp-workspace-actions),
  .app-shell .app-nav:not(.collapsed) .tp-item.menu-open .tp-label ~ .tp-count.needs-you:has(+ .tp-workspace-actions) { display: none; }
}
''')
