import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SelectEmpty } from './SelectEmpty';
import { Spinner } from './Spinner';
import './Table.css';

/**
 * The box a native `table.orbit-table` scrolls sideways in, as the replaced data table's did: wider
 * content scrolls, and an edge with more beyond it is shaded.
 */
export function TableScroll({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => {
      const start = node.scrollLeft > 0;
      const end = node.scrollLeft < node.scrollWidth - node.clientWidth;
      setMore((current) => (current.start === start && current.end === end ? current : { start, end }));
    };
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    return () => {
      node.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, []);
  return (
    <div className="orbit-table-scroll" data-more-start={more.start || undefined} data-more-end={more.end || undefined}>
      <div ref={box} className="orbit-table-content">
        {children}
      </div>
    </div>
  );
}

/**
 * The box of a native `table.orbit-table` that fits its width instead of scrolling sideways (the
 * table is 100% wide): the table's surface and, while `loading`, the replaced table's veil — what is
 * there dimmed and inert under a spinner in its middle.
 */
export function TableFrame({ loading = false, className, style, children }: {
  loading?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={`orbit-table-frame${className ? ` ${className}` : ''}`} style={style}>
      {loading && <Spinner className="orbit-table-frame-spinner" />}
      <div className="orbit-table-frame-body" data-loading={loading || undefined} aria-busy={loading || undefined}>
        {children}
      </div>
    </div>
  );
}

/** A table with no rows: the replaced table's illustration and "No data", across its columns. */
export function TableEmptyRow({ colSpan }: { colSpan: number }) {
  return (
    <tr className="orbit-table-placeholder">
      <td colSpan={colSpan}>
        <SelectEmpty />
      </td>
    </tr>
  );
}
