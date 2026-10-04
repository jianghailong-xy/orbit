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
import { useLayoutEffect, useState, type ReactNode } from 'react';
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
    // Carry each notification's original animation time into its new parent.
    for (const toast of host.querySelectorAll<HTMLElement>('[data-toast-enter-start]')) {
      toast.style.animationDelay = `${Number(toast.dataset.toastEnterStart) - Number(document.timeline.currentTime)}ms`;
    }
    (portal ?? document.body).appendChild(host);
    host.showPopover?.();
    return () => { host.remove(); };
  }, [host, portal]);
  useLayoutEffect(() => {
    let held = false;
    const release = () => {
      if (!held) return;
      held = false;
      releaseToasts();
    };
    // WebKit can omit mouseleave when a hovered node changes modal owners.
    // mouseover also covers a notification arriving or moving under a still
    // pointer. Movement remains necessary when WebKit omits a boundary event.
    const trackHover = (event: MouseEvent) => {
      const target = event.target;
      const next = target instanceof Element && host.contains(target) && !!target.closest('[data-toast-dwell]');
      // Reapply hold on entry: clearing the feed resets the store's hold state.
      if (next) { held = true; holdToasts(); }
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
  }, [host]);
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

  const pinned = !narrow && allPinned ? [...feed.pinned].reverse() : feed.pinned.slice(-1);
  const passing = narrow ? feed.transient.slice(-1) : feed.transient;
  if (pinned.length === 0 && passing.length === 0) return null;

  return createPortal(
    <section className={narrow ? 'toast-viewport toast-viewport--narrow' : 'toast-viewport'} aria-label="Notifications"
      onAnimationStart={(event) => {
        const toast = event.target;
        if (!(toast instanceof HTMLElement) || !event.animationName.startsWith('orbit-toast-') || toast.dataset.toastEnterStart) return;
        const animation = toast.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === event.animationName);
        if (animation) toast.dataset.toastEnterStart = String(Number(document.timeline.currentTime) - Number(animation.currentTime));
      }}
      style={viewportWidth ? narrow
        ? { width: `calc(${viewportWidth}px - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))` }
        : { left: `calc(${viewportWidth}px - max(16px, env(safe-area-inset-right, 0px)) - 360px)`, right: 'auto' }
        : undefined}>
      {pinned.map((toast) =>
        narrow && feed.expanded !== toast.id ? (
          <Pill key={toast.id} toast={toast} behind={feed.pinned.length - 1} onClick={() => openToast(toast.id)} />
        ) : (
          <AttentionCard key={toast.id} toast={toast} onOpen={openSession} />
        ),
      )}
      {!narrow && feed.pinned.length > 1 && (
        <button type="button" className="toast-more" onClick={() => setAllPinned((all) => !all)}>
          {allPinned ? 'Show less' : `+${feed.pinned.length - 1} more`}
        </button>
      )}
      {passing.map((toast) =>
        levelOf(toast) === 'result' ? (
          <ResultCard key={toast.id} toast={toast} onOpen={openSession} />
        ) : (
          <Pill key={toast.id} toast={toast} onClick={toast.sessionId ? () => openSession(toast) : undefined} />
        ),
      )}
    </section>,
    host,
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

/** ③ What failed, what it was about, the server's words to read twice and paste, and what to do. */
function AttentionCard({ toast, onOpen }: { toast: ToastItem; onOpen: (toast: ToastItem) => void }) {
  const copyable = typeof toast.detail === 'string' ? toast.detail : null;
  const action = toast.action;
  return (
    <div className={`toast toast--card toast--attention toast--${toast.tone} toast--live`}>
      <div className="toast-row">
        <Glyph toast={toast} />
        <span className="toast-copy">
          <Copy toast={toast} withDetail={false} />
        </span>
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => closeToast(toast.id)}>
          <CloseOutlined />
        </button>
      </div>
      {present(toast.detail) && <div className="toast-reason">{toast.detail}</div>}
      {(action || toast.sessionId || copyable) && (
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
          {toast.sessionId && (
            <button
              type="button"
              className={action ? 'toast-action' : 'toast-action toast-action--primary'}
              onClick={() => onOpen(toast)}
            >
              Open session
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
