import type { DragEvent as ReactDragEvent, ReactNode, TouchEvent as ReactTouchEvent } from 'react';
import { EllipsisOutlined } from '@ant-design/icons';
import { Menu, type MenuItem } from './ui/Menu';
import { actionWidths, swipeActionsOnScreen, type SwipeWidths } from '../lib/sessionSwipe';

// One row of the session list, for a plain session and a project alike: a project's row is its
// coordinator's session row with the project's content and actions passed in
// (docs/session-list-projects-design.md §4). Everything a row does is written here once — keyboard
// focus and Enter/Space, the click's guards, right-click and the held press's menu, the ⋯ menu and
// where focus goes back to, the swipe strip and its full swipe, the drag onto a folder and its
// image, the selected look. The list's own state for all of it (which menu is open, which row is
// swiped, the drag in flight) is the controller the list hands every row.

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

/** The list's state and gestures, shared by every row it draws. */
export interface SessionRowController {
  /** A touch phone: swipes and a held press, no drag, no ⋯. */
  touch: boolean;
  menuOpenId: string | null;
  onMenuOpenChange: (id: string, open: boolean) => void;
  closeMenu: () => void;
  pressMenu: SessionRowPress | null;
  closePressMenu: () => void;
  /** Where the row `id`'s content rests or follows the finger. */
  swipeState: (id: string, widths: SwipeWidths) => { offset: number; dragging: boolean; armed: boolean };
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
  /** The session being dragged onto a folder, by id. */
  draggingId: string | null;
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

export function SessionListRow({
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
  /** The icon and the two lines. */
  children: ReactNode;
}) {
  const widths = actionWidths(swipe);
  const { offset, dragging: swiping, armed } = rows.swipeState(id, widths);
  const menuOpen = rows.menuOpenId === id;
  const canDrag = draggable && !editing;
  const open = (): void => {
    if (editing || !rows.takeClick()) return;
    onOpen();
  };
  return (
    <div
      {...data}
      className={`session-row${className ? ` ${className}` : ''}${active ? ' active' : ''}${menuOpen ? ' menu-open' : ''}${rows.draggingId === subject.id ? ' dragging' : ''}`}
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
      {rows.touch && rows.pressMenu?.id === id && (
        <Menu
          open
          side="bottom"
          align="start"
          // Where the finger is held: an empty mark the menu is placed against, not a control.
          nativeButton={false}
          popupClassName="session-row-menu session-press-menu"
          onOpenChange={(next) => { if (!next) rows.closePressMenu(); }}
          items={menu(rows.closePressMenu)}
          trigger={<span className="session-press-anchor" style={{ left: rows.pressMenu.x, top: rows.pressMenu.y }} />}
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
            items={menu(rows.closeMenu, () => rows.kebab(id))}
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
}
