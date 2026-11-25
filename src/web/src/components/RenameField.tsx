import { useRef, useState } from 'react';
import { FOLDER_COPY } from '../lib/sessionFolders';

/** Rename… in place (a session row, a schedule's inspector): the title in a field, drawn as a folder's Rename… is.
 * The header editor's rules: Return or leaving the field hands back the trimmed title — unchanged text too, as the
 * header does — and Esc or an emptied field hands back null. */
export function RenameField({ title, label, onDone }: { title: string; label: string; onDone: (title: string | null) => void }) {
  const [draft, setDraft] = useState(title);
  const cancelled = useRef(false);
  return (
    <div className="session-rename">
      <input
        className="folder-name-input"
        autoFocus
        maxLength={200}
        aria-label={label}
        value={draft}
        onFocus={(e) => {
          // All of it selected (typing replaces it), with its head in view: Chromium keeps the field
          // scrolled to the end it focused at, whichever way the selection runs.
          const el = e.currentTarget;
          el.setSelectionRange(0, el.value.length, 'backward');
          el.scrollLeft = 0;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // let the IME (e.g. pinyin) keep Enter
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        onBlur={() => onDone(cancelled.current ? null : draft.trim() || null)}
      />
      <span className="session-folder-hint">{FOLDER_COPY.editHint}</span>
    </div>
  );
}
