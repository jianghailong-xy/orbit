// Multi-select state for the task list: which rows are checked, plus the anchor a Shift
// range is drawn from. Pure functions, because the range semantics are the part users
// actually notice and the part that is easy to get subtly wrong.

export type SelectionAnchor = { id: string; mode: 'add' | 'remove' };

export type Selection = {
  ids: Set<string>;
  // The row of the last non-Shift selection action, and the direction that action took.
  anchor: SelectionAnchor | null;
  // Snapshot of `ids` from when the current Shift sequence began. Repeated Shift-clicks
  // redraw the range against this snapshot instead of stacking ranges on top of each
  // other, so the far end can be dragged back and forth without leaving debris behind.
  base: Set<string> | null;
};

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null, base: null };

// Check or uncheck one row. It becomes the anchor, and the direction it just moved decides
// what a following Shift range does: unchecking a row and then Shift-clicking further down
// clears that whole range rather than selecting it, as Gmail does.
export function toggleOne(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids);
  const adding = !ids.has(id);
  if (adding) ids.add(id);
  else ids.delete(id);
  return { ids, anchor: { id, mode: adding ? 'add' : 'remove' }, base: null };
}

// Draw the range anchor -> id over `order` (the row ids as currently sorted and filtered),
// applied to the snapshot rather than to the live selection. Without a usable anchor —
// nothing selected yet, or an anchor that has since scrolled out of the filter — this
// degrades to a plain toggle.
export function extendTo(sel: Selection, id: string, order: string[]): Selection {
  if (!sel.anchor) return toggleOne(sel, id);
  const a = order.indexOf(sel.anchor.id);
  const b = order.indexOf(id);
  if (a === -1 || b === -1) return toggleOne(sel, id);
  const base = sel.base ?? sel.ids;
  const ids = new Set(base);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) {
    if (sel.anchor.mode === 'add') ids.add(order[i]);
    else ids.delete(order[i]);
  }
  return { ids, anchor: sel.anchor, base };
}

// Move the anchor without changing what is checked — what a plain cursor move does, so a
// Shift-extend afterwards grows from wherever the cursor ended up.
export function anchorAt(sel: Selection, id: string): Selection {
  return { ids: sel.ids, anchor: { id, mode: 'add' }, base: null };
}

// Select every visible row. The anchor is dropped: a select-all leaves no one row for a
// following Shift range to be measured from.
export function selectAll(order: string[]): Selection {
  return { ids: new Set(order), anchor: null, base: null };
}

// Keep what is checked but forget the anchor. A range is defined by two rows' positions,
// so re-sorting or re-searching the list invalidates it even though the rows survive.
export function dropAnchor(sel: Selection): Selection {
  return sel.anchor === null && sel.base === null
    ? sel
    : { ids: sel.ids, anchor: null, base: null };
}
