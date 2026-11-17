import { useEffect } from 'react';

/** The tab's title while a help page is open: "<title> — Orbit Help". */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return undefined;
    const prev = document.title;
    document.title = `${title} — Orbit Help`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
