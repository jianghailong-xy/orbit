import type { ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { DriveChatChangeGroup } from '@orbit/shared';
import { sendTurn } from '../../api';
import { encodeId } from '../../lib/idCodec';
import { formatSize, formatWhen, restoreDriveGroup } from '../../lib/drive';
import { driveChangesPending, driveGroupLines, undoDriveChatGroup } from '../../lib/driveChanges';
import {
  DRIVE_ACTIVITY_EMPTY,
  driveActivityDays,
  driveActivityLineText,
  driveActivityQuery,
  driveActivityUndoLabel,
  markDriveSyncHandled,
  syncAgentWorking,
  syncNeedsYou,
} from '../../lib/driveActivity';
import { refreshDriveSyncs, syncRunning, type DriveSync } from '../../lib/driveSyncs';
import type { DriveUpload } from '../../lib/driveUploads';
import { useToast } from '../../lib/toast';
import { DrivePendingActions, pendingStatus } from './DrivePendingActions';

/** Failed files a row lists before "N more". */
const FAILED_SHOWN = 2;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'Something went wrong');

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="drive-act-section" aria-label={title}>
      <h3 className="drive-act-h">{title}</h3>
      {children}
    </section>
  );
}

function Bar({ fraction, label }: { fraction: number | null; label: string }) {
  const percent = fraction === null ? 0 : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      className={`drive-xfer-bar${fraction === null ? ' is-indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : percent}
    >
      <span style={fraction === null ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

const syncFraction = (sync: DriveSync): number | null =>
  sync.filesTotal ? sync.filesDone / sync.filesTotal : sync.bytesTotal ? sync.bytesSent / sync.bytesTotal : null;

function HeldRow({ group, chatTitle, onOpenChat }: { group: DriveChatChangeGroup; chatTitle: string; onOpenChat: (sessionId: string) => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const undo = useMutation({
    mutationFn: () => undoDriveChatGroup(group.sessionId, group.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['drive'] }),
    onError: (e) => toast.warning("Couldn't undo", messageOf(e)),
  });
  const lines = driveGroupLines(group);
  return (
    <div className="drive-act-row is-amber" data-group={group.id}>
      <div className="drive-act-title">{driveChangesPending(group.heldItems.length)}</div>
      <div className="drive-act-meta">
        {formatWhen(group.createdAt)}{lines[0] ? ` · ${lines[0].kind} ${lines[0].detail}` : ''} · {chatTitle}
      </div>
      <div className="drive-act-actions">
        <button type="button" className="drive-act-btn is-primary" onClick={() => onOpenChat(group.sessionId)}>Review in chat</button>
        <button type="button" className="drive-act-btn" disabled={undo.isPending} onClick={() => undo.mutate()}>Undo</button>
      </div>
    </div>
  );
}

function SyncRow({ sync, children }: { sync: DriveSync; children?: ReactNode }) {
  const client = useQueryClient();
  const toast = useToast();
  const clear = useMutation({
    mutationFn: () => markDriveSyncHandled(sync.id),
    onSuccess: async () => {
      await refreshDriveSyncs();
      await client.invalidateQueries({ queryKey: ['drive', 'activity'] });
    },
    onError: (e) => toast.warning("Couldn't clear", messageOf(e)),
  });
  // A plain retry: the session that ran the sync is the one that can read the source folder.
  const retry = useMutation({
    mutationFn: () =>
      sendTurn(
        sync.session!.id,
        `Sync ${sync.sourceName} to ${sync.destPath} again. ${sync.failedCount} files failed last time:\n` +
          sync.failed.map((f) => `${f.path}: ${f.error}`).join('\n'),
      ),
    onError: (e) => toast.warning("Couldn't retry", messageOf(e)),
  });
  const needs = syncNeedsYou(sync);
  return (
    <div className={`drive-act-row${needs ? ' is-amber' : ''}`} data-sync={sync.id}>
      <div className="drive-act-title">
        {sync.sourceName} → {sync.destPath}
        {sync.failedCount > 0 && <b className="drive-act-bad"> {sync.failedCount} failed</b>}
      </div>
      <div className="drive-act-meta">
        {formatWhen(sync.endedAt ?? sync.startedAt)}
        {sync.filesTotal !== null ? ` · ${sync.filesTotal.toLocaleString()} files` : ''}
        {sync.session ? ` · ${sync.session.title}` : ''}
      </div>
      {sync.failed.length > 0 && (
        <ul className="drive-act-failed">
          {sync.failed.slice(0, FAILED_SHOWN).map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> · {f.error}
            </li>
          ))}
          {sync.failedCount > FAILED_SHOWN && <li>{sync.failedCount - FAILED_SHOWN} more</li>}
        </ul>
      )}
      {sync.failed.length === 0 && sync.error && <div className="drive-act-meta">{sync.error}</div>}
      {children}
      {needs && (
        <div className="drive-act-actions">
          {/* The hand-off button ("Have the agent fix it") is wired by the next task. */}
          <span className="drive-act-handoff" data-slot="hand-off" />
          <button type="button" className="drive-act-btn" disabled={!sync.session || retry.isPending} onClick={() => retry.mutate()}>Retry failed</button>
          <button type="button" className="drive-act-btn" disabled={clear.isPending} onClick={() => clear.mutate()}>Clear</button>
        </div>
      )}
    </div>
  );
}

function UploadRow({ upload }: { upload: DriveUpload }) {
  const fraction = upload.size ? upload.sentBytes / upload.size : 0;
  const name = upload.relativePath ?? upload.name;
  return (
    <div className="drive-act-row" data-upload={upload.key}>
      <div className="drive-act-title">
        {name} <span className="drive-act-dest">→ {upload.parentName}</span>
      </div>
      <Bar fraction={fraction} label={`Uploading ${name}`} />
      <div className="drive-act-meta">
        {pendingStatus(upload)} · {formatSize(upload.sentBytes)} of {formatSize(upload.size)} <DrivePendingActions upload={upload} />
      </div>
    </div>
  );
}

/**
 * The activity log in the Drive chat panel (board drive-web 01 ⑤): Needs you, Agents working on it, Running, then each
 * day's work by session. No chat box here; the icon in the panel's corner goes back to the chat.
 */
export function DriveActivityView({
  held,
  syncs,
  uploads,
  onOpenChat,
}: {
  held: { group: DriveChatChangeGroup; chatTitle: string }[];
  syncs: DriveSync[];
  uploads: DriveUpload[];
  onOpenChat: (sessionId: string) => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const log = useInfiniteQuery(driveActivityQuery());
  const days = driveActivityDays(log.data?.pages.flatMap((page) => page.groups) ?? []);

  const undoLine = useMutation({
    mutationFn: async (target: { kind: 'CHANGE_GROUP' | 'TRASH_GROUP'; id: string; sessionId: string | null }) => {
      if (target.kind === 'TRASH_GROUP') await restoreDriveGroup(target.id);
      else await undoDriveChatGroup(target.sessionId!, target.id);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['drive'] }),
    onError: (e) => toast.warning("Couldn't undo", messageOf(e)),
  });

  const needsYou = syncs.filter(syncNeedsYou);
  const working = syncs.filter(syncAgentWorking);
  const running = syncs.filter(syncRunning);
  const live = uploads.filter((u) => u.status !== 'done');
  const quiet = !held.length && !needsYou.length && !working.length && !running.length && !live.length && !days.length;

  return (
    <div className="drive-act" data-testid="drive-activity">
      {(held.length > 0 || needsYou.length > 0) && (
        <Section title="Needs you">
          {held.map((h) => <HeldRow key={h.group.id} group={h.group} chatTitle={h.chatTitle} onOpenChat={onOpenChat} />)}
          {needsYou.map((sync) => <SyncRow key={sync.id} sync={sync} />)}
        </Section>
      )}
      {working.length > 0 && (
        <Section title="Agents working on it">
          {working.map((sync) => (
            <SyncRow key={sync.id} sync={sync}>
              <div className="drive-act-actions">
                {sync.fixSessionId && (
                  <button type="button" className="drive-act-btn" onClick={() => navigate(`/sessions/${encodeId(sync.fixSessionId!)}`)}>Open session ›</button>
                )}
              </div>
            </SyncRow>
          ))}
        </Section>
      )}
      {(running.length > 0 || live.length > 0) && (
        <Section title="Running">
          {running.map((sync) => (
            <div className="drive-act-row" key={sync.id} data-sync={sync.id}>
              <div className="drive-act-title">{sync.sourceName} → {sync.destPath}</div>
              <Bar fraction={syncFraction(sync)} label={`Syncing ${sync.sourceName}`} />
              <div className="drive-act-meta">
                {sync.filesDone.toLocaleString()}{sync.filesTotal !== null ? ` of ${sync.filesTotal.toLocaleString()}` : ''} files
              </div>
            </div>
          ))}
          {live.map((u) => <UploadRow key={u.key} upload={u} />)}
        </Section>
      )}
      {days.map((day) => (
        <section className="drive-act-section" key={day.key} aria-label={day.label}>
          <h3 className="drive-act-h">{day.label}</h3>
          {day.groups.map((group) => (
            <div className="drive-act-group" key={`${group.sessionId ?? 'you'}-${group.at}`}>
              <div className="drive-act-ghead">
                <b>{group.sessionTitle ?? (group.sessionId ? 'Session' : 'You')}</b>
                <span className="drive-act-meta">{formatWhen(group.at)}</span>
                {group.sessionId && (
                  <button
                    type="button"
                    className="drive-act-link"
                    onClick={() => (group.isDriveChat ? onOpenChat(group.sessionId!) : navigate(`/sessions/${encodeId(group.sessionId!)}`))}
                  >
                    {group.isDriveChat ? 'Open chat ›' : 'Open session ›'}
                  </button>
                )}
              </div>
              {group.lines.map((line) => {
                const label = driveActivityUndoLabel(line);
                return (
                  <div className="drive-act-line" key={`${line.op}-${line.folderPath}-${line.at}-${line.undo?.id ?? ''}`}>
                    <span>{driveActivityLineText(line)}</span>
                    {label && line.undo && (
                      <button
                        type="button"
                        className="drive-act-btn"
                        disabled={undoLine.isPending}
                        onClick={() => undoLine.mutate({ ...line.undo!, sessionId: group.sessionId })}
                      >
                        {label}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      ))}
      {log.hasNextPage && (
        <button type="button" className="drive-act-btn" disabled={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>Show older</button>
      )}
      {quiet && !log.isPending && <div className="drive-act-empty">{DRIVE_ACTIVITY_EMPTY}</div>}
    </div>
  );
}
