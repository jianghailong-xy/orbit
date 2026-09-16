import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Radio } from 'antd';
import type { ClaudeHistoryResult } from '../api';

/** What to do with the Claude Code conversations already recorded in a directory being taken over. */
export type ImportMode = 'none' | 'latest' | 'all';

/** Transcript sizes, in the one unit the offer states them in. */
export const fmtTranscriptSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const fmtLastActive = (iso?: string): string =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

/**
 * The offer made when the directory someone is pointing a new workspace at already has Claude Code
 * conversations recorded in it.
 *
 * Three choices, not a checklist. What a person has an opinion about at this moment is *this
 * directory's history* — they are still naming the workspace, and nobody can make two hundred
 * separate decisions there; so consent is asked for at the granularity it can actually be given.
 * That is also why this panel is a fixed height: a directory holding six hundred conversations
 * takes up exactly as much of the form as one holding six.
 *
 * Every number here came from the runner's own scan of its own disk — the control plane cannot see
 * `~/.claude/projects` at all — and the window is the runner's, stated rather than assumed: Claude
 * Code rolls transcripts away on its own schedule, so "all your history" is a promise this cannot
 * make and does not.
 */
export function ClaudeHistoryOffer({
  history,
  value,
  onChange,
}: {
  history: ClaudeHistoryResult;
  value: ImportMode;
  onChange: (mode: ImportMode) => void;
}) {
  const latest = history.transcripts[0];
  return (
    <>
      <div className="rd-form-section">Local Claude Code history</div>
      <div className="rd-history-panel">
        <div className="rd-path-hint rd-path-ok">
          <CheckCircleOutlined />
          <span>
            <b>
              {history.conversations} Claude Code{' '}
              {history.conversations === 1 ? 'conversation' : 'conversations'}
            </b>{' '}
            in this directory · last {history.windowDays} days · {fmtTranscriptSize(history.bytes)}
          </span>
        </div>
        <Radio.Group
          className="rd-history-choices"
          value={value}
          onChange={(e) => onChange(e.target.value as ImportMode)}
        >
          <Radio value="none">
            <span className="rd-history-choice">
              <span className="rd-set-label">{"Don't import"}</span>
              <span className="rd-set-desc">
                They stay on the runner. You can import later from workspace settings.
              </span>
            </span>
          </Radio>
          <Radio value="latest">
            <span className="rd-history-choice">
              <span className="rd-set-label">{"Only the one I'm in the middle of"}</span>
              <span className="rd-set-desc">
                {latest?.title || 'Untitled conversation'} · last active{' '}
                {fmtLastActive(latest?.lastActiveAt)} · {latest?.messages ?? 0} messages
              </span>
            </span>
          </Radio>
          <Radio value="all">
            <span className="rd-history-choice">
              {/* Counted from the transcripts actually offered, so this number is what pressing it
                  imports — never the directory total when one scan could not carry them all. */}
              <span className="rd-set-label">All {history.transcripts.length}</span>
              <span className="rd-set-desc">
                ~{history.events} events · imported in the background, the workspace is usable right
                away
              </span>
            </span>
          </Radio>
        </Radio.Group>
        <div className="rd-path-hint rd-path-warn">
          <WarningOutlined />
          <span>
            Transcripts include full tool output — file contents, environment variables, anything a
            command printed. They can be removed later.
          </span>
        </div>
      </div>
    </>
  );
}
