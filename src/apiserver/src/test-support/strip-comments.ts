// Shared by the source-scanning guards (sessions/session-terminal-status-readers.spec.ts and
// sessions/session-status-column.spec.ts).

const REGEX_BEFORE = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_AFTER_WORD = /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * The text with every comment blanked out, strings and template literals kept. A quote string ends
 * at its line's end at the latest, so an apostrophe in JSX text costs one line, not the file.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  // One entry per open template literal: the brace depth of the `${` that left it.
  const templates: number[] = [];
  let depth = 0;
  const significant = (): string => out.trimEnd();
  const template = (): void => {
    // Inside a template literal, at i. Copies up to the closing backtick or a `${`.
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        out += c;
        i += 1;
        templates.pop();
        return;
      } else if (c === '$' && text[i + 1] === '{') {
        out += '${';
        i += 2;
        depth += 1;
        return;
      } else {
        out += c;
        i += 1;
      }
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '`') {
      out += c;
      i += 1;
      templates.push(depth);
      template();
    } else if (c === '/') {
      const before = significant();
      const prev = before[before.length - 1] ?? '';
      if (prev === '' || REGEX_BEFORE.has(prev) || REGEX_AFTER_WORD.test(before)) {
        // A regex literal: copy it whole, classes included, so a quote or slash inside is inert.
        let j = i + 1;
        let inClass = false;
        while (j < n && text[j] !== '\n') {
          if (text[j] === '\\') j += 1;
          else if (text[j] === '[') inClass = true;
          else if (text[j] === ']') inClass = false;
          else if (text[j] === '/' && !inClass) break;
          j += 1;
        }
        out += text.slice(i, j + 1);
        i = j + 1;
      } else {
        out += c;
        i += 1;
      }
    } else if (c === '{') {
      depth += 1;
      out += c;
      i += 1;
    } else if (c === '}') {
      depth -= 1;
      out += c;
      i += 1;
      if (templates.length > 0 && templates[templates.length - 1] === depth) template();
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}
