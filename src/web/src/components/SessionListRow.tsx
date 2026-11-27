import { memo, useRef, type DragEvent as ReactDragEvent, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react';
import { EllipsisOutlined } from '@ant-design/icons';
import { Menu, type MenuItem } from './ui/Menu';
import { actionWidths, restingOffset, swipeActionsOnScreen, type SwipeSide } from '../lib/sessionSwipe';

// One row of the session list, for a plain session and a project alike: a project's row is its
// coordinator's session row with the project's content and actions passed in
// (docs/session-list-projects-design.md §4). Everything a row does is written here once — keyboard
// focus and Enter/Space, the click's guards, right-click and the held press's menu, the ⋯ menu and
// where focus goes back to, the swipe strip and its full swipe, the drag onto a folder and its
// image, the selected look. The list's gestures are the controller the list hands every row, the same
// object for every row and every render; what of the list's state is this row's (its menu open, its
// swipe, its drag) comes as the row's own props, so a row redraws only when something of its own
// changed (docs/session-list-scale-design.md §4).

/** One button behind a swipe, and the same action as the row's menus run it. */
export interface SessionRowSwipeButton {
  /** Its class and key: what the action is (`complete`, `pin`, `move`, …). */
  action: string;
  label: string;
  icon: ReactNode;
  disabled: boolean;
  run: () => void;
}

/** A row's swipe actions per edge, outermost first. */
export interface SessionRowSwipe {
  leading: SessionRowSwipeButton[];
  trailing: SessionRowSwipeButton[];
  /** Whether releasing a long rightward swipe runs the first leading action now. */
  fullSwipe: boolean;
}

/** Where a held press opened a row's menu, in the row's own coordinates. */
export interface SessionRowPress {
  id: string;
  x: number;
  y: number;
}

/** The list's gestures, shared by every row it draws: one stable object, whose functions act on the list's
 *  state as it is when they are called. */
export interface SessionRowController {
  /** A touch phone: swipes and a held press, no drag, no ⋯. */
  touch: boolean;
  onMenuOpenChange: (id: string, open: boolean) => void;
  closeMenu: () => void;
  closePressMenu: () => void;
  /** A click on a row (or a control in it) that should act: false when it only ends a swipe or shuts an
   *  open one, which it then does. */
  takeClick: () => boolean;
  touchStart: (e: ReactTouchEvent, id: string, swipe: SessionRowSwipe) => void;
  touchMove: (e: ReactTouchEvent) => void;
  touchEnd: (e?: ReactTouchEvent) => void;
  touchCancel: () => void;
  /** Each row's ⋯ by row id, where focus goes back to when a confirmation its menu opened closes. */
  kebabRef: (id: string) => (node: HTMLButtonElement | null) => void;
  kebab: (id: string) => HTMLElement | null;
  startDrag: (e: ReactDragEvent, subject: any) => void;
  endDrag: () => void;
}

/** The menu a row offers, from its ⋯, a right-click or a held press. `close` closes the menu the item
 *  is in; `kebab` reads the row's ⋯ (absent for the held press's menu, which has none). */
export type SessionRowMenu = (close: () => void, kebab?: () => HTMLElement | null) => MenuItem[];

/** Offset of the drag card's top-left from the pointer's tip (px): below and to the right, so the
 *  arrow and the folder it is over stay in sight. */
export const DRAG_CARD_OFFSET = 16;

/** The drag image: a compact card with the row's title alone, built off-screen for the browser to
 *  photograph and removed once it has. */
export function setTitleDragImage(dataTransfer: DataTransfer, title: string): void {
  if (typeof dataTransfer.setDragImage !== 'function') return;
  const card = document.createElement('div');
  card.className = 'session-drag-card';
  card.textContent = title;
  document.body.appendChild(card);
  dataTransfer.setDragImage(card, -DRAG_CARD_OFFSET, -DRAG_CARD_OFFSET);
  window.setTimeout(() => card.remove(), 0);
}

/** A row's swipe as the list holds it: the finger dragging it, or the side it was left open on. */
export interface SessionRowSwipeState {
  drag: { dx: number; armed: boolean } | null;
  open: SwipeSide | null;
}

export const SessionListRow = memo(function SessionListRow({
  rows,
  id,
  subject,
  title,
  className,
  active,
  editing = false,
  draggable,
  swipe,
  menu,
  menuLabel = 'More actions',
  onOpen,
  data,
  menuOpen,
  pressAt,
  swipeAt,
  dragging,
  children,
}: {
  rows: SessionRowController;
  /** The row's key in the list's state: the session's id, or the project row's. */
  id: string;
  /** The session the row acts on and is dragged as: the session itself, or the project's coordinator. */
  subject: { id: string };
  /** What the drag card says. */
  title: string;
  /** The variant's own classes, after `session-row`. */
  className?: string;
  active: boolean;
  /** A field is open in the row (Rename): a press there is the field's, and the row neither opens, swipes
   *  nor drags. */
  editing?: boolean;
  /** Whether the row may be picked up and dropped on a folder (`sessionRowDraggable`). */
  draggable: boolean;
  swipe: SessionRowSwipe;
  menu: SessionRowMenu;
  /** The ⋯'s name. */
  menuLabel?: string;
  /** What a click, Enter or Space opens, once the click's guards have let it through. */
  onOpen: () => void;
  data?: Record<`data-${string}`, string>;
  /** Whether this row's ⋯ menu is open. */
  menuOpen: boolean;
  /** Where a held press opened this row's menu, or null. */
  pressAt: { x: number; y: number } | null;
  /** This row's swipe, or null when it rests closed. */
  swipeAt: SessionRowSwipeState | null;
  /** Whether this row is the one being dragged onto a folder. */
  dragging: boolean;
  /** The icon and the two lines. */
  children: ReactNode;
}) {
  const widths = actionWidths(swipe);
  const offset = swipeAt?.drag ? swipeAt.drag.dx : restingOffset(swipeAt?.open ?? null, widths);
  const swiping = !!swipeAt?.drag;
  const armed = !!swipeAt?.drag?.armed;
  // The menu is built when it opens, not on every draw of the row; the last one built stays while it
  // closes, so its exit is not an empty popup.
  const builtMenu = useRef<MenuItem[]>([]);
  if (menuOpen) builtMenu.current = menu(rows.closeMenu, () => rows.kebab(id));
  const canDrag = draggable && !editing;
  const open = (): void => {
    if (editing || !rows.takeClick()) return;
    onOpen();
  };
  return (
    <div
      {...data}
      className={`session-row${className ? ` ${className}` : ''}${active ? ' active' : ''}${menuOpen ? ' menu-open' : ''}${dragging ? ' dragging' : ''}`}
      role="button"
      tabIndex={0}
      draggable={canDrag || undefined}
      onDragStart={canDrag ? (e) => {
        // Nothing in the list stays selected under the drag, and the image is the title alone.
        window.getSelection()?.removeAllRanges();
        setTitleDragImage(e.dataTransfer, title);
        rows.startDrag(e, subject);
      } : undefined}
      onDragEnd={canDrag ? rows.endDrag : undefined}
      // While a field is open, a press anywhere else on the row keeps the field's focus (leaving the
      // field saves).
      onMouseDown={(e) => {
        if (editing && !(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        open();
      }}
      // A right-click (or the keyboard's menu key) opens the ⋯ menu. A touch phone's long press
      // opens the held press's menu instead, so its own context menu is only kept off the row.
      onContextMenu={(e) => {
        if (editing) return;
        e.preventDefault();
        if (!rows.touch) rows.onMenuOpenChange(id, true);
      }}
      onTouchStart={(e) => { if (!editing) rows.touchStart(e, id, swipe); }}
      onTouchMove={rows.touchMove}
      onTouchEnd={rows.touchEnd}
      onTouchCancel={rows.touchCancel}
    >
      {rows.touch && pressAt && (
        <Menu
          open
          side="bottom"
          align="start"
          // Where the finger is held: an empty mark the menu is placed against, not a control.
          nativeButton={false}
          popupClassName="session-row-menu session-press-menu"
          onOpenChange={(next) => { if (!next) rows.closePressMenu(); }}
          items={menu(rows.closePressMenu)}
          trigger={<span className="session-press-anchor" style={{ left: pressAt.x, top: pressAt.y }} />}
        />
      )}
      {rows.touch &&
        (['leading', 'trailing'] as const).map((side) => (
          <div
            key={side}
            className={`session-swipe-actions ${side}${swiping ? ' dragging' : ''}${side === 'leading' && armed ? ' armed' : ''}`}
            style={{ width: Math.max(0, side === 'leading' ? offset : -offset) }}
          >
            {swipeActionsOnScreen(side, swipe[side]).map((button) => (
              <button
                key={button.action}
                type="button"
                className={`session-swipe-action ${button.action}`}
                aria-label={button.label}
                aria-disabled={button.disabled}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  button.run();
                }}
              >
                <span className="session-swipe-glyph">{button.icon}</span>
                <span className="session-swipe-title" aria-hidden="true">{button.label}</span>
              </button>
            ))}
          </div>
        ))}
      <div
        className={`session-swipe${swiping ? ' dragging' : ''}`}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
      >
        {children}
      </div>
      <div className="session-right">
        {/* The menu stops its own clicks before they reach the row, which would open it. */}
        <div className="session-actions" onClick={(e) => e.stopPropagation()}>
          <Menu
            side="bottom"
            align="end"
            popupClassName="session-row-menu"
            open={menuOpen}
            onOpenChange={(next) => rows.onMenuOpenChange(id, next)}
            items={builtMenu.current}
            trigger={
              <button ref={rows.kebabRef(id)} type="button" className="session-kebab" aria-label={menuLabel}>
                <EllipsisOutlined />
              </button>
            }
          />
        </div>
      </div>
    </div>
  );
});
