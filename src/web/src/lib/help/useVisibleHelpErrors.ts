import { useEffect, useState } from 'react';
import { HELP_ERROR_ATTR } from './drawerArticles';

const read = (): string[] => {
  const out: string[] = [];
  document.querySelectorAll<HTMLElement>(`[${HELP_ERROR_ATTR}]`).forEach((el) => {
    const slug = el.getAttribute(HELP_ERROR_ATTR);
    if (slug && !el.hidden && !out.includes(slug)) out.push(slug);
  });
  return out;
};

const same = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * The error slugs the cards on the page declare now (`data-help-error`), kept up to date as cards come and go while
 * the drawer is open beside them.
 */
export function useVisibleHelpErrors(): string[] {
  const [errors, setErrors] = useState<string[]>(read);
  useEffect(() => {
    const update = () => setErrors((prev) => {
      const next = read();
      return same(prev, next) ? prev : next;
    });
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [HELP_ERROR_ATTR, 'hidden'] });
    return () => observer.disconnect();
  }, []);
  return errors;
}
