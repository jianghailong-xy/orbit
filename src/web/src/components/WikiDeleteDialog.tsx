import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wikiHealthQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { WikiSpaceRow } from '../lib/wiki';
import {
  WIKI_CANCEL,
  WIKI_DELETE_CONFIRM,
  WIKI_DELETE_KEPT,
  wikiDeleteBody,
  wikiDeleteComesBack,
  wikiDeleted,
  wikiDeleteQuestion,
} from '../lib/wikiReviewMode';
import { deleteWikiSpace } from '../lib/wikiWrites';
import { useConfirm } from './ui/ConfirmDialog';

/**
 * What the question says. The dialog opens at once and the entries are read behind it, so a press never waits on a
 * count, and a read that fails leaves a sentence with no number in it.
 */
function WikiDeleteDescription({ space }: { space: WikiSpaceRow }) {
  const health = useQuery(wikiHealthQuery(space.id));
  return (
    <div className="wk-delete-lines">
      <div>{wikiDeleteBody(health.data?.entries ?? null, space.docs?.written ?? 0)}</div>
      {space.repoUrlNorm && <div>{wikiDeleteComesBack(space.repoUrlNorm)}</div>}
      <div>{WIKI_DELETE_KEPT}</div>
    </div>
  );
}

/**
 * Delete wiki (docs/mocks/wiki-delete, contract `space.delete`): the one question, from a wiki's row in the sidebar and
 * from the foot of its settings. A refusal stays in the dialog, as `ConfirmDialog` keeps every failure. `afterDeleted`
 * says where the reader goes, which only the caller knows.
 */
export function useDeleteWiki(afterDeleted: (space: WikiSpaceRow) => void) {
  const client = useQueryClient();
  const toast = useToast();
  const [confirm, holder] = useConfirm();
  const ask = (space: WikiSpaceRow, name: string): void => {
    void confirm({
      title: wikiDeleteQuestion(name),
      description: <WikiDeleteDescription space={space} />,
      confirmText: WIKI_DELETE_CONFIRM,
      cancelText: WIKI_CANCEL,
      danger: true,
      onConfirm: async () => {
        await deleteWikiSpace(space.id);
        afterDeleted(space);
        toast.success(wikiDeleted(name));
        await client.invalidateQueries({ queryKey: ['wiki'] });
      },
    });
  };
  return [ask, holder] as const;
}
