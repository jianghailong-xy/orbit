import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { copyText } from '../lib/clipboard';
import { Diff, KeyVals, Pre, relPath } from './ToolBlocks';
import { Tooltip, TEXT_TOOLTIP_DELAY_MS } from './ui/Tooltip';

/**
 * The body of a plain tool-call approval: what the call does, not its input as JSON
 * (docs/mocks/tool-call-card). A command is shown as the command, a file tool as its path and
 * change, a fetch as its URL; any other tool as its fields, with the raw input one press away.
 */

/** Lines of a command or a file's content shown before the fold, as in the transcript's output. */
export const TOOL_FOLD_LINES = 12;

type Input = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const asInput = (input: unknown): Input =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as Input) : {};

/** The card's question: what the call is about to do. */
export function toolCallHeading(toolName: string | null | undefined, input: unknown): string {
  const i = asInput(input);
  switch (toolName) {
    case 'Bash':
      return 'Run a command?';
    case 'Edit':
    case 'MultiEdit':
      return 'Edit a file?';
    case 'Write':
      return 'Write a file?';
    case 'Read':
      return 'Read a file?';
    case 'NotebookEdit':
      return 'Edit a notebook?';
    case 'WebFetch':
      return 'Fetch a web page?';
    case 'WebSearch':
      return 'Search the web?';
    case 'Grep':
    case 'Glob':
      return 'Search files?';
    default:
      return text(i.command) ? 'Run a command?' : 'Approve tool call?';
  }
}

/** One line for the folded review card: the command's first line, the path, the URL. */
export function toolCallSummary(toolName: string | null | undefined, input: unknown): string {
  const i = asInput(input);
  const first = text(i.command).trim().split('\n')[0];
  return (
    text(i.description).trim() ||
    first ||
    relPath(text(i.file_path) || text(i.notebook_path)) ||
    text(i.url) ||
    text(i.query) ||
    text(i.pattern) ||
    toolName ||
    ''
  );
}

function duration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 60_000) return `${Math.round(ms / 6_000) / 10} min`;
  return `${Math.round(ms / 1000)} s`;
}

function Chips({ items }: { items: { label: string; warn?: boolean }[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="approval-meta">
      {items.map((c) => (
        <span key={c.label} className={c.warn ? 'is-warn' : undefined}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

function PathLine({ path }: { path: string }): JSX.Element {
  const shown = relPath(path);
  const cut = shown.lastIndexOf('/');
  return (
    <Tooltip content={path} delay={TEXT_TOOLTIP_DELAY_MS} mono>
      <div className="approval-path">
        {cut >= 0 && <span className="approval-path-dir">{shown.slice(0, cut + 1)}</span>}
        {shown.slice(cut + 1)}
      </div>
    </Tooltip>
  );
}

function CopyButton({ value }: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);
  return (
    <button
      type="button"
      className="approval-copy"
      onClick={() =>
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.clearTimeout(reset.current);
          reset.current = window.setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Command({ command }: { command: string }): JSX.Element {
  return (
    <div className="approval-cmd">
      <CopyButton value={command} />
      <Pre text={command} prompt threshold={TOOL_FOLD_LINES} />
    </div>
  );
}

function RawInput({ input }: { input: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="approval-raw-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾ Hide raw input' : '▸ Show raw input'}
      </button>
      {open && <pre className="approval-input">{JSON.stringify(input ?? {}, null, 2)}</pre>}
    </>
  );
}

const lineCount = (s: string): number => (s ? s.split('\n').length : 0);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

export function ToolCallBody({
  toolName,
  input,
  translatedDescription,
}: {
  toolName: string | null | undefined;
  input: unknown;
  /** Settings › Translation: the description in the owner's language, when the server has it. */
  translatedDescription?: string;
}): JSX.Element {
  const i = asInput(input);
  const original = text(i.description).trim();
  // The description once: the owner's language first, the agent's own words beside it in grey.
  const description =
    translatedDescription || original ? (
      <div className="approval-translated-desc">
        {translatedDescription || original}
        {translatedDescription && original && translatedDescription !== original && (
          <span className="approval-desc-original">{original}</span>
        )}
      </div>
    ) : null;

  let body: ReactNode;
  const command = text(i.command);
  if (toolName === 'Bash' || (command && !['Edit', 'MultiEdit', 'Write'].includes(toolName ?? ''))) {
    const timeout = typeof i.timeout === 'number' && i.timeout > 0 ? i.timeout : 0;
    body = (
      <>
        <Command command={command} />
        <Chips
          items={[
            ...(timeout ? [{ label: `timeout ${duration(timeout)}` }] : []),
            ...(i.run_in_background === true ? [{ label: 'runs in background' }] : []),
            ...(i.dangerouslyDisableSandbox === true ? [{ label: 'sandbox off', warn: true }] : []),
          ]}
        />
      </>
    );
  } else if (toolName === 'Edit') {
    body = (
      <>
        <PathLine path={text(i.file_path)} />
        {(i.old_string !== undefined || i.new_string !== undefined) && (
          <Diff oldStr={text(i.old_string)} newStr={text(i.new_string)} />
        )}
        <Chips items={i.replace_all === true ? [{ label: 'Every occurrence' }] : []} />
      </>
    );
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(i.edits) ? (i.edits as Input[]) : [];
    body = (
      <>
        <PathLine path={text(i.file_path)} />
        {edits.map((e, k) => (
          <Diff key={k} oldStr={text(e?.old_string)} newStr={text(e?.new_string)} />
        ))}
        <Chips items={[{ label: plural(edits.length, 'edit') }]} />
      </>
    );
  } else if (toolName === 'Write') {
    const content = text(i.content);
    body = (
      <>
        <PathLine path={text(i.file_path)} />
        {content && <Pre text={content} threshold={TOOL_FOLD_LINES} />}
        <Chips items={[{ label: plural(lineCount(content), 'line') }]} />
      </>
    );
  } else if ((toolName === 'Read' || toolName === 'NotebookEdit') && (text(i.file_path) || text(i.notebook_path))) {
    const offset = typeof i.offset === 'number' ? i.offset : undefined;
    const limit = typeof i.limit === 'number' ? i.limit : undefined;
    const from = offset ?? 1;
    body = (
      <>
        <PathLine path={text(i.file_path) || text(i.notebook_path)} />
        <Chips items={offset || limit ? [{ label: limit ? `lines ${from}–${from + limit - 1}` : `from line ${from}` }] : []} />
      </>
    );
  } else if (toolName === 'WebFetch' && text(i.url)) {
    const prompt = text(i.prompt).trim();
    body = (
      <>
        {!description && prompt && <div className="approval-translated-desc">{prompt}</div>}
        <div className="approval-path">{text(i.url)}</div>
      </>
    );
  } else if (toolName === 'WebSearch' && text(i.query)) {
    body = <div className="approval-path">{text(i.query)}</div>;
  } else if ((toolName === 'Grep' || toolName === 'Glob') && text(i.pattern)) {
    body = (
      <>
        <div className="approval-path">{text(i.pattern)}</div>
        <Chips
          items={[
            ...(text(i.path) ? [{ label: `in ${relPath(text(i.path))}` }] : []),
            ...(text(i.glob) ? [{ label: text(i.glob) }] : []),
          ]}
        />
      </>
    );
  } else {
    const { description: _shown, ...fields } = i;
    body = (
      <>
        {Object.keys(fields).length > 0 && <KeyVals obj={fields} />}
        <RawInput input={input} />
      </>
    );
  }
  return (
    <div className="approval-tool">
      {description}
      {body}
    </div>
  );
}
