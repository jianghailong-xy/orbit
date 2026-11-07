import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  commitSession,
  discardSessionCheckout,
  getAbandonedCheckoutDiff,
  getAbandonedCheckouts,
  type AbandonedCheckout,
} from '../api';
import { useToast } from '../lib/toast';
import { useRefreshSessionLists } from '../lib/useControlPlane';
import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';
import { Spinner } from './ui/Spinner';

const TITLE = 'Uncommitted checkouts';
const HINT =
  'Finished sessions whose checkouts still hold changes no branch has. Commit them to the session’s branch, or discard them so the checkout can be reclaimed.';

/**
 * The checkouts of this machine's finished sessions that still hold uncommitted work — the one
 * thing worktree GC may never remove, and therefore the one thing that used to stay on disk
 * forever. Each row says what changed, opens to the diff, and offers the two exits: commit the
 * work onto the session's branch, or throw it away.
 *
 * The list is the runner's own scan (GET /runners/:id/abandoned-checkouts); both actions ride the
 * commit relay the session composer already uses, so what happens is the same machinery, delivered
 * on the runner's next heartbeat (≤30s).
 */
export function AbandonedCheckouts({
  runnerId,
  canDiscard,
}: {
  runnerId: string;
  /** Whether this runner declared `abandoned-checkout-v1`. An older one would read a discard as a
   *  plain commit and put the work on the branch instead of throwing it away, so the button is
   *  not offered — the server refuses it too, this is only the honest absence of it. */
  canDiscard: boolean;
}) {
  const qc = useQueryClient();
  const refreshSessionLists = useRefreshSessionLists();
  const message = useToast();
  const [confirm, confirmation] = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  // The action pressed locally, so its button can say what is happening until the server's
  // commitStatus catches up (it lands with the runner's next heartbeat).
  const [busy, setBusy] = useState<{ sessionId: string; action: 'commit' | 'discard' } | null>(null);

  const list = useQuery({
    queryKey: ['runner-abandoned-checkouts', runnerId],
    queryFn: () => getAbandonedCheckouts(runnerId),
    // A queued action changes state on the runner's heartbeat; a shorter tick while one is in
    // flight is what makes the row leave when the work does.
    refetchInterval: busy ? 5_000 : 30_000,
  });
  const checkouts = list.data?.checkouts ?? [];

  const diff = useQuery({
    queryKey: ['runner-abandoned-checkout-diff', runnerId, open],
    queryFn: () => getAbandonedCheckoutDiff(runnerId, open!),
    enabled: open != null,
  });

  const settle = (headline: string, detail?: string) => {
    setBusy(null);
    void qc.invalidateQueries({ queryKey: ['runner-abandoned-checkouts', runnerId] });
    refreshSessionLists();
    message.success(headline, detail);
  };

  const commit = useMutation({
    mutationFn: (entry: AbandonedCheckout) => commitSession(entry.sessionPublicId ?? entry.sessionId),
    onSuccess: (_answer, entry) => settle('Committing the checkout’s work to its branch', entry.branch ?? undefined),
    onError: (error: Error, entry) => {
      setBusy(null);
      message.error('Couldn’t queue the commit', error.message);
    },
  });
  const discard = useMutation({
    mutationFn: (entry: AbandonedCheckout) => discardSessionCheckout(entry.sessionPublicId ?? entry.sessionId),
    onSuccess: (_answer, entry) => settle('Discarding the checkout’s uncommitted work', entry.branch ?? undefined),
    onError: (error: Error) => {
      setBusy(null);
      message.error('Couldn’t queue the discard', error.message);
    },
  });

  const askDiscard = (entry: AbandonedCheckout) =>
    void confirm({
      title: 'Discard this checkout’s uncommitted work?',
      description:
        'The changes are removed from the checkout, which then becomes reclaimable. The runner keeps a copy of them in the repository, so they can still be recovered from there.',
      confirmText: 'Discard',
      danger: true,
      cancelText: 'Cancel',
      onConfirm: async () => {
        setBusy({ sessionId: entry.sessionId, action: 'discard' });
        await discard.mutateAsync(entry);
      },
    });

  if (checkouts.length === 0) return null;

  return (
    <>
      <section className="rd-section rd-abandoned" aria-label={TITLE}>
        <div className="rd-section-head">
          <div className="rd-section-title">{TITLE}</div>
        </div>
        <div className="rd-box ac-box">
          {checkouts.map((entry) => {
            const add = entry.files.reduce((sum, file) => sum + Math.max(0, file.additions), 0);
            const del = entry.files.reduce((sum, file) => sum + Math.max(0, file.deletions), 0);
            const working = entry.commitStatus === 'pending';
            const mine = busy?.sessionId === entry.sessionId ? busy.action : null;
            const openHere = open === entry.sessionId;
            return (
              <div className="ac-entry" key={entry.sessionId}>
                <div className="ac-row">
                  <button
                    type="button"
                    className="ac-toggle"
                    aria-expanded={openHere}
                    onClick={() => setOpen(openHere ? null : entry.sessionId)}
                  >
                    <span className="ac-title">{entry.title}</span>
                    {entry.branch && (
                      <span className="ac-branch">
                        <span aria-hidden="true">⎇</span> {entry.branch}
                      </span>
                    )}
                    <span className="ac-stat">
                      <span className="wt-add">+{add}</span> <span className="wt-del">−{del}</span>
                      <span className="wt-dim">
                        {' '}
                        · {entry.files.length} {entry.files.length === 1 ? 'file' : 'files'}
                      </span>
                    </span>
                  </button>
                  <div className="ac-actions">
                    <Button
                      size="small"
                      disabled={working || busy != null}
                      loading={mine === 'commit'}
                      onClick={() => {
                        setBusy({ sessionId: entry.sessionId, action: 'commit' });
                        commit.mutate(entry);
                      }}
                    >
                      {mine === 'commit' ? 'Committing…' : 'Commit to branch'}
                    </Button>
                    {canDiscard && (
                      <Button
                        size="small"
                        danger
                        disabled={working || busy != null}
                        loading={mine === 'discard'}
                        onClick={() => askDiscard(entry)}
                      >
                        {mine === 'discard' ? 'Discarding…' : 'Discard'}
                      </Button>
                    )}
                  </div>
                </div>
                {working && !mine && <div className="ac-note">Waiting for the runner…</div>}
                {entry.commitStatus === 'error' && entry.commitError && (
                  <div className="ac-note ac-error">{entry.commitResultMessage || entry.commitError}</div>
                )}
                {openHere && (
                  <div className="ac-diff">
                    {diff.isPending ? (
                      <div className="ac-note">
                        <Spinner /> Loading the diff…
                      </div>
                    ) : diff.isError ? (
                      <div className="ac-note ac-error">Couldn’t load this diff.</div>
                    ) : (diff.data?.patches ?? []).length === 0 ? (
                      <div className="ac-note">
                        {entry.hasPatches
                          ? 'No diff to show.'
                          : 'The runner reported this checkout’s files without their diff text. The next scan may bring it.'}
                      </div>
                    ) : (
                      (diff.data?.patches ?? []).map((patch) =>
                        patch.truncated ? (
                          <div className="ac-note" key={patch.path}>
                            {patch.path} — too large to preview.
                          </div>
                        ) : (
                          <div className="ac-file" key={patch.path}>
                            <div className="ac-file-path">{patch.path}</div>
                            <pre className="ac-file-patch">{patch.patch}</pre>
                          </div>
                        ),
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="rd-hint">{HINT}</div>
      </section>
      {confirmation}
    </>
  );
}
