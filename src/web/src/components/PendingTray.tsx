import { useState, type ReactNode } from 'react';
import { AttachmentImage, ChatImage, type TurnImage } from './Transcript';

/**
 * The messages the reader sent that nothing has read yet, on the composer's top edge, one row each
 * (docs/mocks/steer-tray, decided 2026-10-16). They are not part of the conversation until the
 * engine reads them, so the transcript leaves them out (Transcript `UnreadSteer`); what is still
 * open about each — where it is going, how far it got, the way to take it back — is said here,
 * where the reader is typing the next one.
 *
 * A row is headed into the turn running now (a steer: ↳) or queued for the next one (≡). A queued
 * row on an engine that takes a message mid-turn offers Steer, which sends it into the current
 * turn. Withdraw takes a row back and its words return to the composer under any draft. What a row
 * cannot do — a Codex steer cannot be given back once Codex has it — it does not offer.
 */
export interface PendingTrayRow {
  key: string;
  heading: 'current' | 'next';
  /** The reader's words; empty for a message of pictures or files alone. */
  text: string;
  /** A `!cmd`: drawn as the command it will run. */
  shell?: boolean;
  /** This tab's previews of its pictures, else the ids of the pictures it carries. */
  previews: TurnImage[];
  imageIds: string[];
  /** Attachments that are not pictures. */
  files: number;
  /** How it stands: Sending…, Waiting to be read, Withdrawing…, Queued for next turn. */
  state: string;
  /** A press for it is out: the row dims and offers nothing to press twice. */
  busy?: boolean;
  onSteer?: () => void;
  onWithdraw?: () => void;
}

function TrayIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
// ↳: into the turn running now.
const STEER_ICON = <TrayIcon><path d="M4 2.5v5.5a2.5 2.5 0 0 0 2.5 2.5H13" /><path d="M10 7.5l3 3-3 3" /></TrayIcon>;
// ≡ with an arrow: waiting in line for the next turn.
const QUEUED_ICON = <TrayIcon><path d="M2.5 3.5h11M2.5 7h11M2.5 10.5h4.5" /><path d="M9.5 10.5h4M12 9l1.5 1.5L12 12" /></TrayIcon>;
const WITHDRAW_ICON = (
  <TrayIcon>
    <path d="M2.75 4.25h10.5" />
    <path d="M6.25 4.25V3a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1v1.25" />
    <path d="M4 4.25l.6 8.4a1.5 1.5 0 0 0 1.5 1.35h3.8a1.5 1.5 0 0 0 1.5-1.35l.6-8.4" />
  </TrayIcon>
);

/** What a row of pictures and files alone says instead of words: "1 image", "2 images, 1 file". */
export function attachmentsSummary(images: number, files: number): string {
  const parts = [
    images ? `${images} image${images === 1 ? '' : 's'}` : '',
    files ? `${files} file${files === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

function Row({ row }: { row: PendingTrayRow }) {
  // One line, so a long message does not push the composer down the page; pressed, the words open
  // in place (and the tip has them whole on a pointer that can hover).
  const [open, setOpen] = useState(false);
  const words = row.text.trim();
  const shown = words ? (row.shell ? `!${words}` : words) : attachmentsSummary(row.previews.length + row.imageIds.length, row.files);
  const thumb = row.previews[0]
    ? <ChatImage src={row.previews[0].url} className="pending-tray-thumb" alt="Image you sent" />
    : row.imageIds[0]
      ? <AttachmentImage id={row.imageIds[0]} variant="tray" />
      : null;
  return (
    <div className={`pending-tray-row${row.busy ? ' is-busy' : ''}`} role="listitem">
      <span className={`pending-tray-icon${row.heading === 'current' ? ' is-current' : ''}`}>
        {row.heading === 'current' ? STEER_ICON : QUEUED_ICON}
      </span>
      {thumb}
      <span className="pending-tray-body">
        <button
          type="button"
          className={`pending-tray-text${words ? '' : ' is-files'}${row.shell ? ' is-shell' : ''}${open ? ' is-open' : ''}`}
          title={words ? shown : undefined}
          aria-expanded={words ? open : undefined}
          onClick={() => words && setOpen((o) => !o)}
        >
          {shown}
        </button>
        <span className="pending-tray-state">{row.state}</span>
      </span>
      {!row.busy && (row.onSteer || row.onWithdraw) && (
        <span className="pending-tray-actions">
          {row.onSteer && (
            <button type="button" className="pending-tray-btn" onClick={row.onSteer} title="Send into the current turn now">
              {STEER_ICON}
              Steer
            </button>
          )}
          {row.onWithdraw && (
            <button
              type="button"
              className="pending-tray-btn is-icon"
              onClick={row.onWithdraw}
              aria-label="Withdraw"
              title="Withdraw — back to the composer"
            >
              {WITHDRAW_ICON}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** `note` says, under the rows, why none of them can go into the turn running now — an engine that
 *  takes no message mid-turn (Cursor CLI's would stop the turn), said only while one is waiting. */
export function PendingTray({ rows, note }: { rows: readonly PendingTrayRow[]; note?: string | null }) {
  if (rows.length === 0) return null;
  return (
    <div className="pending-tray" role="list" aria-label="Messages not read yet">
      {rows.map((row) => <Row key={row.key} row={row} />)}
      {note && rows.some((row) => row.heading === 'next') && <div className="pending-tray-note">{note}</div>}
    </div>
  );
}
