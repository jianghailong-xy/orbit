import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WikiTrashRow } from '@orbit/shared';
import { wikiHealthQuery, wikiTrashQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { WikiSpaceRow } from '../lib/wiki';
import {
  WIKI_CANCEL,
  WIKI_TRASH_CLOSE,
  WIKI_TRASH_CONFIRM,
  WIKI_TRASH_DELETE_PERMANENTLY,
  WIKI_TRASH_KEPT,
  WIKI_TRASH_LEAVES,
  WIKI_TRASH_OPEN_TRASH,
  WIKI_TRASH_PAGE_EMPTY,
  WIKI_TRASH_PAGE_LEAD,
  WIKI_TRASH_PAGE_TITLE,
  WIKI_TRASH_PURGE_CONFIRM,
  WIKI_TRASH_PURGE_QUESTION,
  WIKI_TRASH_RESTORE,
  wikiMovedToTrash,
  wikiRestored,
  wikiTrashBody,
  wikiTrashComesBack,
  wikiTrashPurgeBody,
  wikiTrashQuestion,
  wikiTrashRowLine,
} from '../lib/wikiReviewMode';
import { moveWikiSpaceToTrash, purgeWikiSpace, restoreWikiSpace } from '../lib/wikiWrites';
import { SidebarNavIcon } from './SidebarNavIcon';
import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';
import { Dialog } from './ui/Dialog';

/**
 * What the question says. The dialog opens at once and the entries are read behind it, so a press never waits on a
 * count, and a read that fails leaves a sentence with no number in it.
 */
function WikiTrashDescription({ space }: { space: WikiSpaceRow }) {
  const health = useQuery(wikiHealthQuery(space.id));
  return (
    <div className="wk-delete-lines">
      <div>{WIKI_TRASH_LEAVES}</div>
      <div>{wikiTrashBody(health.data?.entries ?? null, space.docs?.written ?? 0)}</div>
      {space.repoUrlNorm && <div>{wikiTrashComesBack(space.repoUrlNorm)}</div>}
      <div>{WIKI_TRASH_KEPT}</div>
    </div>
  );
}

/**
 * Move to Trash (docs/mocks/wiki-trash, contract `space.trash`): the one question, from a wiki's row in the sidebar and
 * from the foot of its settings. A refusal stays in the dialog, as `ConfirmDialog` keeps every failure. `afterMoved`
 * says where the reader goes, which only the caller knows.
 */
export function useMoveWikiToTrash(afterMoved: (space: WikiSpaceRow) => void) {
  const client = useQueryClient();
  const toast = useToast();
  const [confirm, holder] = useConfirm();
  const ask = (space: WikiSpaceRow, name: string): void => {
    void confirm({
      title: wikiTrashQuestion(name),
      description: <WikiTrashDescription space={space} />,
      confirmText: WIKI_TRASH_CONFIRM,
      cancelText: WIKI_CANCEL,
      danger: true,
      onConfirm: async () => {
        await moveWikiSpaceToTrash(space.id);
        afterMoved(space);
        toast.success(wikiMovedToTrash(name));
        await client.invalidateQueries({ queryKey: ['wiki'] });
      },
    });
  };
  return [ask, holder] as const;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One wiki in Trash: its name, when it went and when it goes, and the two things that can be done with it. */
function WikiTrashItem({ row, onPurge }: { row: WikiTrashRow; onPurge: (row: WikiTrashRow) => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [restoring, setRestoring] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const restore = async (): Promise<void> => {
    setRestoring(true);
    setRefusal(null);
    try {
      await restoreWikiSpace(row.id);
      toast.success(wikiRestored(row.title));
      await client.invalidateQueries({ queryKey: ['wiki'] });
    } catch (error) {
      // A newer wiki on its repository, in the server's own words: what to do is in the sentence.
      setRefusal(messageOf(error));
    } finally {
      setRestoring(false);
    }
  };
  return (
    <li className="wk-trash-row">
      <span className="wk-trash-ico" aria-hidden="true">
        <SidebarNavIcon name="wiki" />
      </span>
      <div className="wk-trash-text">
        <div className="wk-trash-name">{row.title}</div>
        <div className="wk-trash-line">{wikiTrashRowLine(row)}</div>
      </div>
      <div className="wk-trash-acts">
        <Button loading={restoring} onClick={() => void restore()}>
          {WIKI_TRASH_RESTORE}
        </Button>
        <Button variant="text" danger disabled={restoring} onClick={() => onPurge(row)}>
          {WIKI_TRASH_DELETE_PERMANENTLY}
        </Button>
      </div>
      {refusal && (
        <div className="orbit-confirm-error wk-trash-error" role="alert">
          {refusal}
        </div>
      )}
    </li>
  );
}

/**
 * Trash (docs/mocks/wiki-trash): a dialog rather than a page, since `/wiki/<slug>` is a wiki's address and a page of its
 * own would take the slug `trash` from one. Each wiki in it can be restored, or deleted permanently after a question.
 */
export function WikiTrashDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const trash = useQuery(wikiTrashQuery());
  const [confirm, holder] = useConfirm();
  const rows = trash.data?.spaces ?? [];
  const purge = (row: WikiTrashRow): void => {
    void confirm({
      title: WIKI_TRASH_PURGE_QUESTION,
      description: wikiTrashPurgeBody(row.entries),
      confirmText: WIKI_TRASH_PURGE_CONFIRM,
      cancelText: WIKI_CANCEL,
      danger: true,
      onConfirm: async () => {
        await purgeWikiSpace(row.id);
        await client.invalidateQueries({ queryKey: ['wiki'] });
      },
    });
  };
  return (
    <Dialog
      open
      title={WIKI_TRASH_PAGE_TITLE}
      onClose={onClose}
      width={640}
      className="wk-trash-dialog"
      footer={<Button onClick={onClose}>{WIKI_TRASH_CLOSE}</Button>}
    >
      <div className="wk-trash-lead">{WIKI_TRASH_PAGE_LEAD}</div>
      {trash.isSuccess && rows.length === 0 ? (
        <div className="wk-trash-empty">{WIKI_TRASH_PAGE_EMPTY}</div>
      ) : (
        <ul className="wk-trash-list" aria-label={WIKI_TRASH_PAGE_TITLE}>
          {rows.map((row) => (
            <WikiTrashItem key={row.id} row={row} onPurge={purge} />
          ))}
        </ul>
      )}
      {holder}
    </Dialog>
  );
}

/**
 * The line that leads to Trash where the sidebar's row is not to hand: under Wiki settings' last card, and on the
 * first-wiki card once no wiki is left. Nothing while Trash is empty.
 */
export function WikiTrashLink({ sentence, className }: { sentence: (wikis: number) => string; className?: string }) {
  const trash = useQuery(wikiTrashQuery());
  const [open, setOpen] = useState(false);
  const wikis = trash.data?.spaces?.length ?? 0;
  if (wikis === 0 && !open) return null;
  return (
    <div className={`wk-trash-link${className ? ` ${className}` : ''}`}>
      {wikis > 0 && (
        <>
          {sentence(wikis)}{' '}
          <Button variant="link" className="wk-trash-open" onClick={() => setOpen(true)}>
            {WIKI_TRASH_OPEN_TRASH}
          </Button>
        </>
      )}
      {open && <WikiTrashDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
