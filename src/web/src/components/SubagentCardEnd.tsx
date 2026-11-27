import { createContext, useContext, useState } from 'react';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import type { SubagentRunView } from '@orbit/shared';
import { ExportCtx, MD, relTime } from './Transcript';

/**
 * How a background SubAgent's card ends (docs/mocks/subagent-card-and-end-line, approved 2026-11-20). Like
 * Claude Code's built-in Agent, a SubAgent is one card from start to end: when its run ends, the card's
 * row turns into the end and the line under it into the ending. The turn the control plane opened for
 * the end (`<orbit-subagent-finished>`) draws nothing: the agent still reads that block unchanged, and
 * the card keeps it under `What the agent read`.
 */

export type SubagentEndedRun = SubagentRunView & { status: 'DONE' | 'FAILED' | 'INTERRUPTED' | 'STOPPED' };

/** What a SubAgent's end turn told the agent about one run, joined to its card by run id. */
export interface SubagentWakeSeen {
  /** The `<orbit-subagent-finished>` block, exactly as the agent read it. */
  text: string;
  /** When the agent read it; unset while it was never confirmed delivered. */
  readAt?: string;
}

/** The end turns loaded in this transcript, by run id (built by `Transcript` from its own nodes). */
export const SubagentWakesCtx = createContext<ReadonlyMap<string, SubagentWakeSeen>>(new Map());

/** The end turns still on the queue, by run id: each one's `Don't send`, which takes it off the queue. */
export const SubagentQueuedWakesCtx = createContext<ReadonlyMap<string, () => void>>(new Map());

/** A run whose end the card draws: a background one that has ended. A foreground call is its own end. */
export function subagentEnded(run: SubagentRunView | undefined): SubagentEndedRun | undefined {
  return run && run.background && run.status !== 'RUNNING' ? (run as SubagentEndedRun) : undefined;
}

/**
 * Why a run ended, said to the reader. The control plane's block says it to the agent in one fixed sentence
 * per end (apiserver `ENDED_BECAUSE`), so the card needs nothing but the run's status to say it — even
 * where the block was never loaded, or never sent.
 */
const BECAUSE: Record<Exclude<SubagentEndedRun['status'], 'DONE'>, string> = {
  INTERRUPTED: 'The runner hosting it stopped (a restart, an update or a crash) before it finished.',
  FAILED: 'It did not finish its work.',
  STOPPED: 'Stopped by the agent.',
};

/** Red for a run that did not finish; grey for one somebody stopped, which is no failure. */
const toneOf = (status: SubagentEndedRun['status']): 'ok' | 'failed' | 'stopped' =>
  status === 'DONE' ? 'ok' : status === 'STOPPED' ? 'stopped' : 'failed';

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path;
const fileCount = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'} left uncommitted`;

/** The row's end: ✓ alone for DONE; the mark and a word chip for every other end. */
export function SubagentEndStatus({ run }: { run: SubagentEndedRun }) {
  const tone = toneOf(run.status);
  const word = run.status.toLowerCase();
  if (tone === 'ok') return <CheckCircleFilled className="chat-tool-status ok" aria-label="done" />;
  return (
    <>
      <span className={`chat-subagent-end-chip is-${tone}`}>{word}</span>
      {tone === 'stopped' ? (
        <span className="chat-tool-status stopped" role="img" aria-label={word} />
      ) : (
        <CloseCircleFilled className="chat-tool-status err" aria-label={word} />
      )}
    </>
  );
}

/** `9 files left uncommitted Show files model-routing.ts · task-route-decision.ts · +7` */
function FilesLine({ files, onShow }: { files: string[]; onShow: () => void }) {
  if (files.length === 0) return null;
  const first = files.slice(0, 2).map(basename);
  return (
    <div className="chat-subagent-ending-files">
      {fileCount(files.length)}{' '}
      <button
        type="button"
        className="chat-subagent-link"
        onClick={(event) => {
          event.stopPropagation();
          onShow();
        }}
      >
        Show files
      </button>
      <span className="chat-subagent-ending-names">
        {[...first, ...(files.length > first.length ? [`+${files.length - first.length}`] : [])].join(' · ')}
      </span>
    </div>
  );
}

/**
 * The folded card's ending, where the live line was while it ran: two lines of what a run that finished
 * handed back, or why one did not, once, and the files it left.
 */
export function SubagentFoldedEnd({ run, onShowFiles }: { run: SubagentEndedRun; onShowFiles: () => void }) {
  const tone = toneOf(run.status);
  if (tone === 'ok') {
    if (!run.resultSummary) return null;
    return (
      <div className="chat-subagent-ending is-ok">
        <div className="chat-subagent-ending-md">
          <MD>{run.resultSummary}</MD>
        </div>
      </div>
    );
  }
  return (
    <div className={`chat-subagent-ending is-${tone}`}>
      <div className="chat-subagent-ending-reason">{BECAUSE[run.status as keyof typeof BECAUSE]}</div>
      <FilesLine files={run.changedFiles} onShow={onShowFiles} />
    </div>
  );
}

/** While the end turn waits on the queue: the agent has not read it yet, and it can still be kept back. */
export function SubagentWakeQueued({ onDontSend }: { onDontSend: () => void }) {
  return (
    <div className="chat-subagent-queued">
      Waiting for the agent to read it ·{' '}
      <button
        type="button"
        className="chat-subagent-link"
        onClick={(event) => {
          event.stopPropagation();
          onDontSend();
        }}
      >
        Don&apos;t send
      </button>
    </div>
  );
}

/** How many of the files an opened end lists before the reader asks for the rest. */
const FILES_SHOWN = 3;

/**
 * The opened card's foot: how it ended and when, every file it left, what the agent read, and the run.
 */
export function SubagentEndBlock({
  run,
  runId,
  wake,
}: {
  run: SubagentEndedRun;
  runId: string | null;
  wake: SubagentWakeSeen | undefined;
}) {
  const exporting = useContext(ExportCtx) !== null;
  const [allFiles, setAllFiles] = useState(false);
  const tone = toneOf(run.status);
  const when = run.endedAt ? ` ${relTime(run.endedAt)}` : '';
  const head =
    tone === 'ok'
      ? null
      : tone === 'stopped'
        ? `Stopped${when} by the agent.`
        : `${run.status === 'FAILED' ? 'Failed' : 'Interrupted'}${when}: ${lowerFirst(BECAUSE[run.status as keyof typeof BECAUSE])}`;
  const files = run.changedFiles;
  const shown = allFiles || exporting ? files : files.slice(0, FILES_SHOWN);
  const readAt = wake?.readAt ? clock(wake.readAt) : null;
  return (
    <div className={`chat-subagent-end is-${tone}`}>
      {head && <div className="chat-subagent-end-head">{head}</div>}
      {files.length > 0 && (
        <>
          <div className="chat-subagent-end-files-head">{fileCount(files.length)} in the working tree:</div>
          <ul className="chat-subagent-end-files">
            {shown.map((file) => (
              <li key={file}>{file}</li>
            ))}
            {shown.length < files.length && (
              <li>
                <button type="button" className="chat-subagent-link" onClick={() => setAllFiles(true)}>
                  … {files.length - shown.length} more
                </button>
              </li>
            )}
          </ul>
        </>
      )}
      {wake && (
        <details className="chat-subagent-end-raw">
          <summary>What the agent read</summary>
          <pre>{wake.text}</pre>
        </details>
      )}
      {runId && (
        <div className="chat-subagent-end-run">
          Run {runId}
          {readAt && ` · read by the agent at ${readAt}`}
        </div>
      )}
    </div>
  );
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
