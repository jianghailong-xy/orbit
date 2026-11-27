import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WarningFilled } from '@ant-design/icons';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { copyText } from '../../lib/clipboard';
import {
  checkDriveShare,
  formatSize,
  messageOf,
  shareDriveFile,
  stopSharing,
  type DriveEntry,
  type DriveShareLink,
  type DriveShareWarning,
} from '../../lib/drive';
import { publicLinkUrl } from '../../lib/shareLinks';
import { useToast } from '../../lib/toast';

/** "an AWS access key id" → "An AWS access key id": the scan names the shape the way a sentence would. */
const shapeLabel = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);

/** Said whenever the scan stopped before the end of the file (25 MiB or 20 s, §9). */
export const partialNote = (checkedBytes: number) =>
  `Only the first ${formatSize(checkedBytes)} of this file was checked for secrets.`;

type Phase =
  | { at: 'checking' }
  | { at: 'warn'; warnings: DriveShareWarning[]; partial: boolean; checkedBytes: number }
  | { at: 'sharing' }
  | { at: 'shared'; link: DriveShareLink; partial: boolean; checkedBytes: number }
  | { at: 'failed'; message: string };

/**
 * Share one drive file (board 02-web frame 5, D18): only the owner, from the Files page, one file at a time. The file is
 * checked for secrets first; what the check finds is named, shape and line, and the owner may still share. When it finds
 * nothing, the link is made at once. `existing` is the file's open link: when it already pins the current version the
 * dialog only shows it; "Share this version" (`moveToCurrent`) checks again and moves the link to the current version.
 */
export function DriveShareDialog({
  file,
  existing,
  moveToCurrent = false,
  onClose,
}: {
  file: DriveEntry;
  existing: DriveShareLink | null;
  moveToCurrent?: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const showOnly = existing != null && existing.root.pinnedIsCurrent && !moveToCurrent;
  const [phase, setPhase] = useState<Phase>(
    showOnly ? { at: 'shared', link: existing!, partial: false, checkedBytes: 0 } : { at: 'checking' },
  );
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const share = async (partial: boolean, checkedBytes: number) => {
    setPhase({ at: 'sharing' });
    try {
      const answer = await shareDriveFile(file.id);
      await client.invalidateQueries({ queryKey: ['drive', 'share-links'] });
      if (alive.current) {
        setPhase({
          at: 'shared',
          link: answer.link,
          partial: partial || answer.partial,
          checkedBytes: answer.partial ? answer.checkedBytes : checkedBytes,
        });
      }
    } catch (error) {
      if (alive.current) setPhase({ at: 'failed', message: messageOf(error) });
    }
  };

  useEffect(() => {
    if (showOnly) return;
    let stale = false;
    void (async () => {
      try {
        const check = await checkDriveShare(file.id);
        if (stale) return;
        if (check.warnings.length > 0) {
          setPhase({ at: 'warn', warnings: check.warnings, partial: check.partial, checkedBytes: check.checkedBytes });
        } else {
          await share(check.partial, check.checkedBytes);
        }
      } catch (error) {
        if (!stale) setPhase({ at: 'failed', message: messageOf(error) });
      }
    })();
    return () => {
      stale = true;
    };
    // One check per opening.
  }, []);

  const stop = async (link: DriveShareLink) => {
    try {
      await stopSharing(link.id);
      await client.invalidateQueries({ queryKey: ['drive', 'share-links'] });
      toast.success('Stopped sharing', file.name);
      onClose();
    } catch (error) {
      toast.error("Couldn't stop sharing", messageOf(error));
    }
  };

  const footer =
    phase.at === 'warn' ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          className="files-share-anyway"
          onClick={() => void share(phase.partial, phase.checkedBytes)}
        >
          Share anyway
        </Button>
      </>
    ) : phase.at === 'shared' ? (
      <>
        <Button danger variant="text" onClick={() => void stop(phase.link)}>
          Stop sharing
        </Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </>
    ) : (
      <Button onClick={onClose}>{phase.at === 'failed' ? 'Close' : 'Cancel'}</Button>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      width={480}
      className="files-share-dialog"
      title={moveToCurrent ? `Share this version of “${file.name}”` : `Share “${file.name}”`}
      description="Anyone with the link can view and download this one file without signing in. The link shows the version you share; a later change is shared only when you share that version."
      footer={footer}
    >
      {(phase.at === 'checking' || phase.at === 'sharing') && (
        <div className="files-share-status" role="status">
          {phase.at === 'checking' ? 'Checking the file for secrets…' : 'Making the link…'}
        </div>
      )}
      {phase.at === 'warn' && (
        <div className="files-share-warning" role="alert">
          <div className="files-share-warning-head">
            <WarningFilled aria-hidden="true" /> This file looks like it holds secrets
          </div>
          <div>Anyone with the link could read them:</div>
          <ul className="files-share-findings">
            {phase.warnings.map((warning) => (
              <li key={`${warning.kind}-${warning.line}`}>
                <span>{shapeLabel(warning.kind)}</span>
                <span className="files-share-line">line {warning.line}</span>
              </li>
            ))}
          </ul>
          {phase.partial && <div className="files-share-partial">{partialNote(phase.checkedBytes)}</div>}
          <div>You can still share it. Remove them from the file first if they should stay private.</div>
        </div>
      )}
      {phase.at === 'shared' && (
        <div className="files-share-done">
          <div className="files-share-url">
            <Input readOnly value={publicLinkUrl(phase.link.token)} aria-label="Share link" />
            <Button
              onClick={() =>
                void copyText(publicLinkUrl(phase.link.token)).then((copied) =>
                  copied ? toast.success('Link copied') : toast.error("Couldn't copy the link"),
                )
              }
            >
              Copy
            </Button>
          </div>
          {phase.partial && <div className="files-share-partial">{partialNote(phase.checkedBytes)}</div>}
        </div>
      )}
      {phase.at === 'failed' && (
        <div className="files-share-failed" role="alert">
          Couldn't share the file: {phase.message}
        </div>
      )}
    </Dialog>
  );
}
