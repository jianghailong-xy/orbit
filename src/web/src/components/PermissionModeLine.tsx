import type { SessionPermissionModeChange } from '@orbit/shared';
import { decisionReceiptAnchor } from '../lib/decisionReceipt';
import { modeChangeLines, type ModeChangeLine, type ModeFacts } from '../lib/sessionPermissionMode';
import type { TranscriptInsert } from './Transcript';

/** The mode-change lines as a conversation's inserts, each drawn where it happened among the events loaded. */
export function modeChangeInserts(
  changes: readonly SessionPermissionModeChange[],
  facts: ModeFacts & { actual?: string | null },
  events: Parameters<typeof decisionReceiptAnchor>[0],
): TranscriptInsert[] {
  return modeChangeLines(changes, facts).flatMap((line) => {
    const anchor = decisionReceiptAnchor(events, line.at);
    return anchor === null
      ? []
      : [{ anchor, moment: line.at, key: `mode-change:${line.key}`, element: <PermissionModeLine line={line} /> }];
  });
}

/**
 * One recorded change of the session's permission mode, drawn where it happened in the conversation
 * (docs/mocks/permission-mode-actual, the owner's B1): a quiet left-aligned line, as quiet as
 * "⊘ interrupted", with a shield, the sentence saying who or what made the change, and its time.
 * Amber while it is the change behind the gap the Mode capsule shows.
 */
export function PermissionModeLine({ line }: { line: ModeChangeLine }) {
  const at = new Date(line.at);
  const valid = !Number.isNaN(at.getTime());
  return (
    <div className={`chat-mode-line${line.gap ? ' is-gap' : ''}`} data-mode-change={line.key}>
      <svg
        className="chat-mode-line-icon"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.6L8 1.8Z" />
      </svg>
      <span className="chat-mode-line-text">
        {line.before}
        <b>{line.mode}</b>
        {line.after}
      </span>
      {valid && (
        <time className="chat-mode-line-time" dateTime={line.at} title={at.toLocaleString()}>
          {at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}
        </time>
      )}
    </div>
  );
}
