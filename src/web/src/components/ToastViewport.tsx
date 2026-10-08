import {
  BranchesOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CloseOutlined,
  DeleteOutlined,
  ExclamationCircleFilled,
  InfoCircleFilled,
  LoadingOutlined,
  RightOutlined,
  SyncOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import { levelOf, type ToastGlyph, type ToastItem } from '../lib/toastFeed';
import { closeToast, holdToasts, openToast, releaseToasts, useToastFeed } from '../lib/toastStore';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { useFeedbackPortal } from './ui/feedbackPortal';

/**
 * Every toast on screen (docs/mocks/toast-system): what waits for you, pinned, above what passes.
 *
 * The shape follows what a toast asks of you (`levelOf`). A confirmation or a progress line is a pill
 * that hugs its words; a toast with an Undo to decide on or a diagnostic to read is a card; a failure
 * is a tinted card with the server's words in a block you can select, and it stays until its × —
 * nothing posted after it can push it away. Wide screens stack them in the top-right corner, where
 * both of AntD's surfaces used to hang as two separate stacks; a phone centres one column under the
 * top bar and folds an open failure into a pill after six seconds, so it stops covering the page.
 *
 * Mounted once inside the router (main.tsx): clicking a toast that names a session opens it.
 */
export function ToastViewport() {
  const feed = useToastFeed();
  const portal = useFeedbackPortal();
  // A stable React portal keeps notification DOM and hover state across modal
  // ownership changes. The manual popover paints outside ancestor transforms.
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'toast-layer';
    element.popover = 'manual';
    return element;
  });
  useLayoutEffect(() => {
    // Reparenting restarts CSS animations even when React keeps the same DOM.
    // Carry the current entrance or exit time into its new parent.
    for (const toast of host.querySelectorAll<HTMLElement>('[data-toast-animation-start]')) {
      toast.style.animationDelay = `${Number(toast.dataset.toastAnimationStart) - Number(document.timeline.currentTime)}ms`;
    }
    (portal ?? document.body).appendChild(host);
    host.showPopover?.();
    return () => { host.remove(); };
  }, [host, portal]);
  const hovered = useRef<Element | null>(null);
  const release = useCallback(() => {
    if (!hovered.current) return;
    hovered.current = null;
    releaseToasts();
  }, []);
  useLayoutEffect(() => {
    // A dismissed or replaced card may not send a mouse boundary event.
    if (hovered.current && (!host.contains(hovered.current) || hovered.current.closest('.toast-slot--leaving'))) release();
  });
  useLayoutEffect(() => {
    // WebKit can omit mouseleave when a hovered node changes modal owners.
    // mouseover also covers a notification arriving or moving under a still
    // pointer. Movement remains necessary when WebKit omits a boundary event.
    const trackHover = (event: MouseEvent) => {
      const target = event.target;
      const next = target instanceof Element && host.contains(target) && !target.closest('.toast-slot--leaving')
        ? target.closest('[data-toast-dwell]') : null;
      // Reapply hold on entry: clearing the feed resets the store's hold state.
      if (next) { hovered.current = next; holdToasts(); }
      else release();
    };
    document.addEventListener('mouseover', trackHover, true);
    document.addEventListener('mousemove', trackHover, true);
    document.addEventListener('mouseleave', release);
    return () => {
      document.removeEventListener('mouseover', trackHover, true);
      document.removeEventListener('mousemove', trackHover, true);
      document.removeEventListener('mouseleave', release);
      release();
    };
  }, [host, release]);
  const [viewportWidth, setViewportWidth] = useState<number>();
  useLayoutEffect(() => {
    // WebKit top-layer descendants can retain a wider scroll viewport during
    // modal transitions. Match a body-mounted notification even while closing.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none';
    probe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(probe);
    const measure = () => setViewportWidth(probe.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    return () => { observer.disconnect(); probe.remove(); };
  }, []);
  const narrow = useMediaQuery(PHONE_QUERY);
  const navigate = useNavigate();
  const [allPinned, setAllPinned] = useState(false);

  const openSession = (toast: ToastItem) => {
    // A card carrying a diagnostic is also one you select and paste. Releasing a drag counts as a
    // click, so treat one that ends on a selection as the selection, not a jump.
    if (window.getSelection()?.toString()) return;
    if (!toast.sessionId) return;
    closeToast(toast.id);
    navigate(`/sessions/${encodeId(toast.sessionId)}`);
  };

  const visible = useMemo(() => {
    const pinned = !narrow && allPinned ? [...feed.pinned].reverse() : feed.pinned.slice(-1);
    const passing = narrow ? feed.transient.slice(-1) : feed.transient;
    return [
      ...pinned.map((toast) => ({ toast, folded: narrow && feed.expanded !== toast.id, behind: feed.pinned.length - 1 })),
      ...passing.map((toast) => ({ toast, folded: false, behind: 0 })),
    ];
  }, [feed, narrow, allPinned]);
  const [previous, setPrevious] = useState(visible);
  const [shown, setShown] = useState(visible);
  // Keep a departing toast in its slot for the 250ms exit, including its last card/pill shape.
  // Updating during render keeps the new feed and its presentation in the same commit.
  if (previous !== visible) {
    setPrevious(visible);
    const next = [...visible];
    shown.forEach((entry, index) => {
      if (!visible.some((one) => identityOf(one.toast) === identityOf(entry.toast))) next.splice(index, 0, entry);
    });
    setShown(next);
  }
  const remove = useCallback((id: string) => setShown((items) => items.filter((one) => identityOf(one.toast) !== id)), []);
  // A phone column keeps its plain CSS width, as WebKit lays it out in body, until a modal takes it.
  // The moved column can be laid out against another viewport width, also while the modal closes, so
  // from then on it holds the width it last had in body (or the probe's) until it empties.
  const [bodyWidth, setBodyWidth] = useState<{ width: number; viewportWidth?: number }>();
  const [held, setHeld] = useState(false);
  const showing = shown.length > 0;
  if (showing && portal && !held) setHeld(true);
  if (!showing && (held || bodyWidth)) {
    setHeld(false);
    setBodyWidth(undefined);
  }
  const current = useRef({ portal, held, viewportWidth });
  useLayoutEffect(() => { current.current = { portal, held, viewportWidth }; });
  const observeColumn = useCallback((section: HTMLElement | null) => {
    if (!section) return;
    const observer = new ResizeObserver(([entry]) => {
      const { portal, held, viewportWidth } = current.current;
      if (!portal && !held) setBodyWidth({ width: entry.borderBoxSize[0].inlineSize, viewportWidth });
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  if (!showing) return null;

  return createPortal(
    <section ref={observeColumn} className={narrow ? 'toast-viewport toast-viewport--narrow' : 'toast-viewport'} aria-label="Notifications"
      onAnimationStart={(event) => {
        const toast = event.target;
        if (!(toast instanceof HTMLElement) || !event.animationName.startsWith('orbit-toast-') || toast.dataset.toastAnimationStart) return;
        const animation = toast.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === event.animationName);
        if (animation) toast.dataset.toastAnimationStart = String(Number(document.timeline.currentTime) - Number(animation.currentTime));
      }}
      style={viewportWidth ? narrow
        ? held ? { width: bodyWidth?.viewportWidth === viewportWidth ? `${bodyWidth.width}px` : `calc(${viewportWidth}px - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))` } : undefined
        : { left: `calc(${viewportWidth}px - max(16px, env(safe-area-inset-right, 0px)) - 360px)`, right: 'auto' }
        : undefined}>
      {shown.map(({ toast, folded, behind }) => (
        <ToastPresence
          key={identityOf(toast)}
          id={identityOf(toast)}
          leaving={!visible.some((one) => identityOf(one.toast) === identityOf(toast))}
          onExit={remove}
        >
          {folded ? (
            <Pill toast={toast} behind={behind} onClick={() => openToast(toast.id)} />
          ) : levelOf(toast) === 'attention' ? (
            <AttentionCard toast={toast} onOpen={openSession} />
          ) : levelOf(toast) === 'result' ? (
            <ResultCard toast={toast} onOpen={openSession} />
          ) : (
            <Pill toast={toast} onClick={toast.sessionId ? () => openSession(toast) : undefined} />
          )}
        </ToastPresence>
      ))}
      {!narrow && feed.pinned.length > 1 && (
        <button type="button" className="toast-more" onClick={() => setAllPinned((all) => !all)}>
          {allPinned ? 'Show less' : `+${feed.pinned.length - 1} more`}
        </button>
      )}
    </section>,
    host,
  );
}

// A keyed operation keeps its presentation when the feed moves it between transient and pinned.
function identityOf(toast: ToastItem): string {
  return toast.key ?? toast.id;
}

/** Exit is visual only: dismissed actions immediately stop accepting clicks or keyboard focus. */
function ToastPresence({ id, leaving, onExit, children }: {
  id: string;
  leaving: boolean;
  onExit: (id: string) => void;
  children: ReactNode;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The next phase has its own clock; an entrance delay must not skip exit.
    slot.current!.style.animationDelay = '';
    delete slot.current!.dataset.toastAnimationStart;
    // WebKit can keep the old activeElement after its ancestor becomes inert.
    const focused = document.activeElement;
    if (leaving && focused instanceof HTMLElement && slot.current!.contains(focused)) focused.blur();
  }, [leaving]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => onExit(id), 250);
    return () => clearTimeout(timer);
  }, [id, leaving, onExit]);
  return (
    <div ref={slot} className={`toast-slot${leaving ? ' toast-slot--leaving' : ''}`} inert={leaving} aria-hidden={leaving || undefined}>
      {children}
    </div>
  );
}

function present(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

const GLYPHS: Record<ToastGlyph, typeof CheckCircleFilled> = {
  check: CheckCircleFilled,
  trash: DeleteOutlined,
  branch: BranchesOutlined,
  sync: SyncOutlined,
  undo: UndoOutlined,
  info: InfoCircleFilled,
  warning: ExclamationCircleFilled,
  error: CloseCircleFilled,
};

/** The tone picks the glyph unless the caller named one: a failure reads as a failure without every
 *  call site saying so, but "Session permanently deleted" can still show the trash it came from. */
function Glyph({ toast }: { toast: ToastItem }) {
  if (levelOf(toast) === 'progress') {
    return <LoadingOutlined className="toast-glyph toast-glyph--info" aria-hidden="true" />;
  }
  const fallback: ToastGlyph =
    toast.tone === 'error' ? 'error' : toast.tone === 'warning' ? 'warning' : toast.tone === 'success' ? 'check' : 'info';
  const Icon = GLYPHS[toast.icon ?? fallback];
  return <Icon className={`toast-glyph toast-glyph--${toast.tone}`} aria-hidden="true" />;
}

/** The outcome, what it happened to, and — on a result card — the diagnostic: web's reading order. */
function Copy({ toast, withDetail }: { toast: ToastItem; withDetail: boolean }) {
  return (
    <>
      <span className="toast-head">{toast.message}</span>
      {present(toast.subtitle) && <span className="toast-sub">{toast.subtitle}</span>}
      {withDetail && present(toast.detail) && <span className="toast-detail">{toast.detail}</span>}
    </>
  );
}

/** ① a confirmation, a progress line, or a phone's folded failure with the count of the others behind
 *  it. Click-through unless clicking it does something — and then it says so with a chevron. */
function Pill({ toast, behind = 0, onClick }: { toast: ToastItem; behind?: number; onClick?: () => void }) {
  const tinted = levelOf(toast) === 'attention' ? ` toast--${toast.tone}` : '';
  const body = (
    <>
      <Glyph toast={toast} />
      <span className="toast-copy">
        <Copy toast={toast} withDetail={false} />
      </span>
      {behind > 0 && <span className="toast-count">+{behind}</span>}
      {onClick && <RightOutlined className="toast-chev" aria-hidden="true" />}
    </>
  );
  if (!onClick) return <div className={`toast toast--pill${tinted}`}>{body}</div>;
  return (
    <button
      type="button"
      className={`toast toast--pill toast--live${tinted}`}
      onClick={onClick}
      data-toast-dwell=""
    >
      {body}
    </button>
  );
}

/** ② An outcome with the one thing you might do about it. The copy block — not the whole card —
 *  carries the click into the session, so the action keeps its own target. */
function ResultCard({ toast, onOpen }: { toast: ToastItem; onOpen: (toast: ToastItem) => void }) {
  const action = toast.action;
  return (
    <div className="toast toast--card toast--live" data-toast-dwell="">
      <Glyph toast={toast} />
      {toast.sessionId ? (
        <button
          type="button"
          className="toast-copy toast-copy--link"
          aria-label={typeof toast.subtitle === 'string' ? `Open ${toast.subtitle}` : undefined}
          onClick={() => onOpen(toast)}
        >
          <Copy toast={toast} withDetail />
        </button>
      ) : (
        <span className="toast-copy">
          <Copy toast={toast} withDetail />
        </span>
      )}
      {action && (
        <button
          type="button"
          className="toast-action"
          aria-label={action.ariaLabel}
          onClick={() => {
            closeToast(toast.id);
            action.onClick();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** ③ What failed, what it was about, the server's words to read twice and paste, and what to do.
 *
 *  The copy block carries the click into the session, the same as ② — a press that only follows the
 *  toast is one the whole card should answer, not one the card keeps to a button of its own. A
 *  button is left here only for what does MORE than follow it (`action`, which resolves in the
 *  session) or what acts on the card's own text (`Copy error`). */
function AttentionCard({ toast, onOpen }: { toast: ToastItem; onOpen: (toast: ToastItem) => void }) {
  const copyable = typeof toast.detail === 'string' ? toast.detail : null;
  const action = toast.action;
  return (
    <div className={`toast toast--card toast--attention toast--${toast.tone} toast--live`}>
      <div className="toast-row">
        <Glyph toast={toast} />
        {toast.sessionId ? (
          <button
            type="button"
            className="toast-copy toast-copy--link"
            aria-label={typeof toast.subtitle === 'string' ? `Open ${toast.subtitle}` : undefined}
            onClick={() => onOpen(toast)}
          >
            <Copy toast={toast} withDetail={false} />
          </button>
        ) : (
          <span className="toast-copy">
            <Copy toast={toast} withDetail={false} />
          </span>
        )}
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => closeToast(toast.id)}>
          <CloseOutlined />
        </button>
      </div>
      {present(toast.detail) && <div className="toast-reason">{toast.detail}</div>}
      {(action || copyable) && (
        <div className="toast-actions">
          {action && (
            <button
              type="button"
              className="toast-action toast-action--primary"
              aria-label={action.ariaLabel}
              onClick={() => {
                closeToast(toast.id);
                action.onClick();
              }}
            >
              {action.label}
            </button>
          )}
          {copyable && (
            <button type="button" className="toast-action" onClick={() => void navigator.clipboard?.writeText(copyable)}>
              Copy error
            </button>
          )}
        </div>
      )}
    </div>
  );
}
