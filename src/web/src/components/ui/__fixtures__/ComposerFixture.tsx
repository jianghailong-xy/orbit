import {
  useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties, type KeyboardEvent,
  type MouseEvent as ReactMouseEvent, type SyntheticEvent, type UIEvent,
} from 'react';
import { App as AntApp, Avatar, Button as AntButton, ConfigProvider, Image, Input as AntInput } from 'antd';
import { ArrowUpOutlined, CloseOutlined, EyeOutlined, PaperClipOutlined, PlusOutlined } from '@ant-design/icons';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MAX_PROMPT_CHARS } from '@orbit/shared';
import { ThemeProvider, useThemeMode } from '../../../lib/theme';
import { darkTheme, lightTheme } from '../../../theme';
import { ComposerMirror } from '../../ComposerMirror';
import { applyReferencePick, materializeReferences, referenceToken, type ReferenceMap } from '../../../lib/composerRefs';
import {
  LOCAL_SLASH_ITEMS, pickSlash as replaceSlashToken, slashMatches as getSlashMatches, slashToken as getSlashToken,
  type ComposerSlashItem,
} from '../../../lib/slashCommands';
import { Textarea } from '../Textarea';
import './ComposerFixture.css';

// Private P3.1 fixture for ui-migration/composer.html. The session composer (WorkspaceView) and the
// task comment composer (TaskDetailPanel) are reproduced with their real CSS, mirror and helpers,
// around either the AntD field they use today (?impl=ant) or the Orbit Textarea. Everything but the
// field is shared, so a difference between the two pages belongs to the field.

const params = new URLSearchParams(location.search);
const impl = params.get('impl') === 'ant' ? 'ant' : 'orbit';
const scenario = params.get('scenario') === 'comment' ? 'comment' : params.get('scenario') === 'plain' ? 'plain' : 'session';
const fixedWidth = Number(params.get('width')) || undefined;
const disabled = params.has('disabled');

const SLASH_ITEMS: ComposerSlashItem[] = [
  ...LOCAL_SLASH_ITEMS,
  { name: 'review', description: 'Review the current diff', type: 'command' },
  { name: 'refactor', description: 'Restructure without changing behavior', type: 'command' },
  { name: 'release', description: 'Cut a release', type: 'skill' },
];
const WORKSPACES = [{ id: 'w1', name: 'orbit-develop' }, { id: 'w2', name: 'orbit-docs' }, { id: 'w3', name: 'web-pilot', noRunner: true }];
const REFERENCES = [
  { kind: 'list' as const, id: 'list-1', title: 'Base UI migration' },
  { kind: 'list' as const, id: 'list-2', title: 'Release checklist' },
  { kind: 'task' as const, id: 'task-1', title: 'P3.1 自动增高输入框' },
  { kind: 'task' as const, id: 'task-2', title: 'P3.2 Task detail pilot' },
];
const HISTORY = ['Earlier prompt', 'Earlier prompt\nwith a second line'];

/** The field under test. Both expose the native textarea the way their callers reach it today. */
function useField() {
  const ant = useRef<any>(null);
  const orbit = useRef<HTMLTextAreaElement>(null);
  // AntD: through its internal ref, as WorkspaceView/TaskDetailPanel do now. Orbit: the element itself.
  const node = useCallback((): HTMLTextAreaElement | null | undefined =>
    impl === 'ant' ? ant.current?.resizableTextArea?.textArea : orbit.current, []);
  const focus = useCallback(() => (impl === 'ant' ? ant.current?.focus() : orbit.current?.focus()), []);
  return { ant, orbit, node, focus };
}

/** Exactly what the two pages pass their field today. */
interface FieldProps {
  fieldRefs: ReturnType<typeof useField>;
  'aria-label': string;
  value: string;
  placeholder: string;
  disabled: boolean;
  autoSize: false | { minRows: number; maxRows: number };
  variant?: 'outlined' | 'borderless';
  className?: string;
  style?: CSSProperties;
  maxLength?: number;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelect?: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onScroll?: (event: UIEvent<HTMLTextAreaElement>) => void;
}
function Field({ fieldRefs, ...props }: FieldProps) {
  return impl === 'ant' ? <AntInput.TextArea ref={fieldRefs.ant} {...props} /> : <Textarea ref={fieldRefs.orbit} {...props} />;
}

interface Staged { uid: string; name: string; size: number; mime: string; previewUrl?: string }

/** WorkspaceView's composer: attachments, mirror, field, menus, resize handle and send keys. */
function SessionComposer() {
  const field = useField();
  const [text, setText] = useState(params.get('text') ?? '');
  const [composerRefs, setComposerRefs] = useState<ReferenceMap>({});
  const [composerScroll, setComposerScroll] = useState(0);
  const [histIdx, setHistIdx] = useState(-1);
  const [histDraft, setHistDraft] = useState('');
  const [images, setImages] = useState<Staged[]>(params.has('attachments')
    ? [{ uid: 'fixture-image', name: 'pixel.png', size: 68, mime: 'image/png', previewUrl: PIXEL },
      { uid: 'fixture-file', name: 'baseline-note.txt', size: 33, mime: 'text/plain' }]
    : []);
  const [sent, setSent] = useState<string[]>([]);
  const [placeholder, setPlaceholder] = useState(params.get('placeholder') ?? 'Reply…');

  // Manual composer height (px), exactly as WorkspaceView keeps it.
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  const startComposerResize = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault();
    const ta = field.node();
    const startY = e.clientY;
    const startH = ta?.offsetHeight ?? composerHeight ?? 120;
    const onMove = (ev: MouseEvent): void => {
      setComposerHeight(Math.min(Math.max(startH + (startY - ev.clientY), 44), 640));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [composerHeight, field]);
  const [composerCapped, setComposerCapped] = useState(false);
  useEffect(() => {
    const ta = field.node();
    if (!ta) return;
    const id = requestAnimationFrame(() => {
      setComposerCapped(ta.scrollHeight > ta.clientHeight + 1);
    });
    return () => cancelAnimationFrame(id);
  }, [text, composerHeight, field]);

  // `/` menu.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const slashToken = getSlashToken(text);
  const slashMatches = useMemo(() => getSlashMatches(SLASH_ITEMS, slashToken, null), [slashToken]);
  useEffect(() => setSlashIndex(0), [slashToken]);
  const showSlash = slashToken !== null && slashToken !== slashDismissed && slashMatches.length > 0;
  const slashIdx = slashMatches.length ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  const pickSlash = (name: string): void => {
    setText(replaceSlashToken(text, name));
    setSlashDismissed(null);
    setTimeout(() => field.focus(), 0);
  };
  // `@` menu.
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const mentionToken = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1] ?? null;
  const mentionMatches = useMemo(() => {
    if (mentionToken === null) return [];
    const q = mentionToken.toLowerCase();
    return WORKSPACES.filter((a) => a.name.toLowerCase().includes(q)).sort((a, b) => {
      const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    }).slice(0, 8);
  }, [mentionToken]);
  useEffect(() => setMentionIndex(0), [mentionToken]);
  const showMention = mentionToken !== null && mentionToken !== mentionDismissed && mentionMatches.length > 0;
  const mentionIdx = mentionMatches.length ? Math.min(mentionIndex, mentionMatches.length - 1) : 0;
  const pickMention = (name: string): void => {
    setText(text.replace(/(^|\s)@([^\s@]*)$/, `$1@${name} `));
    setMentionDismissed(null);
    setTimeout(() => field.focus(), 0);
  };
  // `#` menu.
  const [refIndex, setRefIndex] = useState(0);
  const [refDismissed, setRefDismissed] = useState<string | null>(null);
  const refToken = referenceToken(text);
  const refMatches = useMemo(() => {
    if (refToken === null) return [];
    const q = refToken.toLowerCase();
    const lists = REFERENCES.filter((r) => r.kind === 'list' && r.title.toLowerCase().includes(q)).slice(0, 5);
    const tasks = refToken ? REFERENCES.filter((r) => r.kind === 'task' && r.title.toLowerCase().includes(q)).slice(0, 5) : [];
    return [...lists, ...tasks];
  }, [refToken]);
  useEffect(() => setRefIndex(0), [refToken]);
  const showRef = refToken !== null && refToken !== refDismissed && refMatches.length > 0;
  const refIdx = refMatches.length ? Math.min(refIndex, refMatches.length - 1) : 0;
  const pickRef = (m: (typeof REFERENCES)[number]): void => {
    const next = applyReferencePick(text, m.title, { kind: m.kind, id: m.id }, composerRefs);
    setText(next.text);
    setComposerRefs(next.refs);
    setRefDismissed(null);
    setTimeout(() => field.focus(), 0);
  };

  const shellMode = text.trim().startsWith('!');
  const onSend = (): void => {
    if (!text.trim() && images.length === 0) return;
    setSent((list) => [...list, materializeReferences(text, composerRefs)]);
    setText('');
    setComposerRefs({});
    setHistIdx(-1);
    setImages([]);
  };
  const addFile = (file: File): void => {
    setImages((list) => [...list, { uid: `${list.length}-${file.name}`, name: file.name, size: file.size, mime: file.type,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined }]);
  };

  return <div className="workspace-composer">
    <div className={shellMode ? 'composer-box composer-box-shell' : 'composer-box'}>
      {(composerHeight != null || composerCapped) && (
        <div className="composer-resize-handle" onMouseDown={startComposerResize} onDoubleClick={() => setComposerHeight(null)}
          title="Drag to resize · double-click to reset" />
      )}
      {showSlash && (
        <div className="composer-slash-menu" role="listbox">
          {slashMatches.map((it, i) => (
            <div key={`${it.type}:${it.name}`} role="option" aria-selected={i === slashIdx}
              className={`composer-slash-item${i === slashIdx ? ' is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pickSlash(it.name); }} onMouseEnter={() => setSlashIndex(i)}>
              <span className="composer-slash-name">/{it.name}</span>
              <span className="composer-slash-type">{it.type === 'skill' ? 'skill' : it.type === 'local' ? 'local' : 'cmd'}</span>
              {it.description && <span className="composer-slash-desc">{it.description}</span>}
            </div>
          ))}
        </div>
      )}
      {showRef && (
        <div className="composer-slash-menu" role="listbox">
          {refMatches.map((m, i) => (
            <div key={`${m.kind}:${m.id}`} role="option" aria-selected={i === refIdx}
              className={`composer-slash-item${i === refIdx ? ' is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pickRef(m); }} onMouseEnter={() => setRefIndex(i)}>
              <span className="composer-slash-name">#{m.title}</span>
              <span className="composer-slash-type">{m.kind === 'list' ? 'list' : 'task'}</span>
            </div>
          ))}
        </div>
      )}
      {showMention && (
        <div className="composer-slash-menu" role="listbox">
          {mentionMatches.map((a, i) => (
            <div key={a.id} role="option" aria-selected={i === mentionIdx}
              className={`composer-slash-item${i === mentionIdx ? ' is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pickMention(a.name); }} onMouseEnter={() => setMentionIndex(i)}>
              <span className="composer-slash-name">@{a.name}</span>
              <span className="composer-slash-type">workspace</span>
            </div>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="composer-attachments">
          {images.map((im) => im.previewUrl ? (
            <span key={im.uid} className="composer-pill composer-attach">
              <Image className="composer-attach-thumb" src={im.previewUrl} alt="" preview={{ mask: <EyeOutlined className="composer-attach-eye" /> }} />
              <button type="button" className="composer-attach-remove" onClick={() => setImages((list) => list.filter((it) => it.uid !== im.uid))}
                aria-label="Remove image"><CloseOutlined /></button>
            </span>
          ) : (
            <span key={im.uid} className="composer-pill composer-file">
              <PaperClipOutlined className="composer-file-icon" />
              <span className="composer-file-name" title={im.name}>{im.name}</span>
              <span className="composer-file-size">{im.size} B</span>
              <button type="button" className="composer-file-remove" onClick={() => setImages((list) => list.filter((it) => it.uid !== im.uid))}
                aria-label="Remove file"><CloseOutlined /></button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-field">
        <ComposerMirror text={text} refs={composerRefs} scrollTop={composerScroll} />
        <Field
          fieldRefs={field}
          aria-label="Message"
          onScroll={(e) => setComposerScroll(e.currentTarget.scrollTop)}
          className={shellMode ? 'composer-shell' : undefined}
          variant="borderless"
          autoSize={composerHeight == null ? { minRows: 1, maxRows: 12 } : false}
          style={composerHeight == null ? undefined : { height: composerHeight }}
          maxLength={MAX_PROMPT_CHARS}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            if (histIdx !== -1) setHistIdx(-1);
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.items ?? []).filter((it) => it.kind === 'file')
              .map((it) => it.getAsFile()).filter((f): f is File => !!f);
            if (files.length) {
              e.preventDefault();
              files.forEach(addFile);
            }
          }}
          onKeyDown={(e) => {
            if (showRef && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setRefIndex((i) => (i + 1) % refMatches.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setRefIndex((i) => (i - 1 + refMatches.length) % refMatches.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickRef(refMatches[refIdx]); return; }
              if (e.key === 'Escape') { e.preventDefault(); setRefDismissed(refToken); return; }
            }
            if (showMention && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMatches.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionMatches[mentionIdx].name); return; }
              if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(mentionToken); return; }
            }
            if (showSlash && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashMatches[slashIdx].name); return; }
              if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(slashToken); return; }
            }
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.nativeEvent.isComposing
              && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
              const ta = e.currentTarget;
              const noSelection = ta.selectionStart === ta.selectionEnd;
              const onFirstLine = !ta.value.slice(0, ta.selectionStart).includes('\n');
              const onLastLine = !ta.value.slice(ta.selectionEnd).includes('\n');
              const setCaret = (pos: number): void => {
                setTimeout(() => { ta.selectionStart = ta.selectionEnd = pos; }, 0);
              };
              if (e.key === 'ArrowUp' && noSelection && onFirstLine) {
                e.preventDefault();
                if (histIdx === -1) setHistDraft(text);
                const idx = histIdx === -1 ? HISTORY.length - 1 : Math.max(0, histIdx - 1);
                setHistIdx(idx);
                setText(HISTORY[idx]);
                setCaret(0);
                return;
              }
              if (e.key === 'ArrowDown' && noSelection && onLastLine && histIdx !== -1) {
                e.preventDefault();
                if (histIdx < HISTORY.length - 1) {
                  const idx = histIdx + 1;
                  setHistIdx(idx);
                  setText(HISTORY[idx]);
                  setCaret(HISTORY[idx].length);
                } else {
                  setHistIdx(-1);
                  setText(histDraft);
                  setCaret(histDraft.length);
                }
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
        />
      </div>
      <div className="composer-toolbar">
        <AntButton className="composer-attach-btn" type="text" icon={<PlusOutlined />} disabled={disabled} aria-label="Add attachment" />
        <span className="composer-pill-spacer" />
        <AntButton className="composer-send" type="primary" shape="circle" icon={<ArrowUpOutlined />}
          disabled={disabled || (!text.trim() && images.length === 0)} onClick={() => onSend()} aria-label="Send" />
      </div>
    </div>
    <div className="fixture-controls">
      <output aria-label="Sent messages">{JSON.stringify(sent)}</output>
      <output aria-label="Capped">{String(composerCapped)}</output>
      <output aria-label="Manual height">{composerHeight == null ? 'auto' : String(composerHeight)}</output>
      <button type="button" onClick={() => setPlaceholder('Reply to Claude’s question about the composer migration and keep the long placeholder wrapping…')}>
        Use long placeholder
      </button>
      <button type="button" onClick={() => setText('Restored draft\nfrom another session')}>Restore draft</button>
      <button type="button" onClick={() => field.focus()}>Focus field</button>
    </div>
  </div>;
}

interface CommentRow { body: string; mentions: string[] }

/** TaskDetailPanel's comment box: @-mentions, ⌘/Ctrl+Enter, and caret restore through the ref. */
function CommentComposer() {
  const field = useField();
  const [draft, setDraft] = useState(params.get('text') ?? '');
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [posted, setPosted] = useState<CommentRow[]>([]);
  const mentionToken = useMemo(() => {
    const before = draft.slice(0, caret);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    return m ? m[1] : null;
  }, [draft, caret]);
  const mentionMatches = useMemo(() => {
    if (mentionToken === null) return [];
    const query = mentionToken.toLowerCase();
    return WORKSPACES.filter((a) => a.name.toLowerCase().includes(query)).sort((a, b) => {
      const pa = a.name.toLowerCase().startsWith(query) ? 0 : 1;
      const pb = b.name.toLowerCase().startsWith(query) ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    }).slice(0, 8);
  }, [mentionToken]);
  useEffect(() => {
    setMentionIndex(0);
    setMentionDismissed(false);
  }, [mentionToken]);
  const showMention = mentionToken !== null && !mentionDismissed && mentionMatches.length > 0;
  const mentionIdx = mentionMatches.length ? Math.min(mentionIndex, mentionMatches.length - 1) : 0;
  const pickMention = (workspace: (typeof WORKSPACES)[number]) => {
    const before = draft.slice(0, caret).replace(/(^|\s)@([^\s@]*)$/, `$1@${workspace.name} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setMentionDismissed(false);
    setTimeout(() => {
      const ta = field.node();
      if (ta) {
        ta.focus();
        ta.setSelectionRange(before.length, before.length);
      }
      setCaret(before.length);
    }, 0);
  };
  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    const mentions = WORKSPACES.filter((a) => new RegExp(`(?:^|\\s)@${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(body)).map((a) => a.id);
    setPosted((list) => [...list, { body, mentions }]);
    setDraft('');
    setCaret(0);
  };

  return <aside className="fixture-task-panel">
    <div className="tdp-compose">
      {showMention && (
        <div className="tdp-mention-menu">
          {mentionMatches.map((a, i) => (
            <div key={a.id} className={`tdp-mention-item ${i === mentionIdx ? 'active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pickMention(a); }} onMouseEnter={() => setMentionIndex(i)}>
              <Avatar size={18} style={{ background: 'var(--brand-tint-hover)', color: 'var(--brand)', fontSize: 10, flex: 'none' }}>
                {a.name.slice(0, 1).toUpperCase()}
              </Avatar>
              <span className="tdp-mention-name">{a.name}</span>
              {a.noRunner && <span className="tdp-mention-norunner">No runner</span>}
            </div>
          ))}
        </div>
      )}
      <Field
        fieldRefs={field}
        aria-label="Comment"
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        placeholder="Add a comment…  type @ to mention a workspace  (⌘/Ctrl + Enter to send)"
        autoSize={{ minRows: 1, maxRows: 4 }}
        onKeyDown={(e) => {
          if (showMention) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMatches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pickMention(mentionMatches[mentionIdx]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return; }
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <AntButton type="primary" onClick={submit} disabled={!draft.trim()}>Send</AntButton>
    </div>
    <div className="fixture-controls">
      <output aria-label="Posted comments">{JSON.stringify(posted)}</output>
      <output aria-label="Caret">{String(caret)}</output>
    </div>
  </aside>;
}

/** The borderless variant outside the composer's CSS: its own rest, focus and disabled look. */
function PlainField() {
  const field = useField();
  const [text, setText] = useState(params.get('text') ?? '');
  return <section className="fixture-plain" aria-label="Plain field">
    <Field fieldRefs={field} aria-label="Borderless field" variant="borderless" value={text} placeholder="Borderless field"
      disabled={disabled} autoSize={{ minRows: 1, maxRows: 12 }} onChange={(e) => setText(e.target.value)} onKeyDown={() => {}} />
  </section>;
}

// 1×1 PNG so the staged-image chip draws a real thumbnail without a network request.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function Content() {
  const { resolved } = useThemeMode();
  return <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}><AntApp>
    <main className={`composer-fixture composer-fixture-${scenario}`} data-impl={impl}
      style={fixedWidth ? { ['--fixture-width' as string]: `${fixedWidth}px` } : undefined}>
      <output data-testid="theme">{resolved}</output>
      {scenario === 'session' ? <SessionComposer /> : scenario === 'comment' ? <CommentComposer /> : <PlainField />}
    </main>
  </AntApp></ConfigProvider>;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
export function ComposerFixture() {
  return <QueryClientProvider client={client}><ThemeProvider><Content /></ThemeProvider></QueryClientProvider>;
}
