import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
