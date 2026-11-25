/**
 * The reading behind sessionDisplayGuard.test.ts: where web source reads a session's seven run states (Queued, Running,
 * Awaiting reply, Finished, Failed, Interrupted, Ended), and in which named function. A lexer, not a parser: it skips
 * strings, template text and comments, follows braces, and names each read by the innermost named function around it
 * (a `function`, a `const name = (…) =>` or `const name = function`, or a method), else the top-level declaration it
 * sits in. Test-only; nothing in the product imports it.
 */

/** The calls and tables that give the seven run states (lib/sessionState). */
export const SEVEN_STATE_READ =
  /\b(sessionRunStateOf|sessionReadingState|sessionStateOf|sessionActivityOf)\s*\(|\b(SESSION_RUN_WORD|SESSION_STATE_META|RUN_TONE)\s*\[/g;

/** The two functions (and their text form) a surface asks first (lib/sessionDisplay). */
export const DISPLAY_CALL = /\b(sessionDisplayState|sessionMarks|sessionDisplayText)\s*\(/g;

export interface ReadSite {
  /** The innermost named function around the read. */
  fn: string;
  /** Where that function starts, as an offset into the source. */
  fnStart: number;
  reader: string;
  offset: number;
  line: number;
}

const NAMED_HEADER = [
  /(?:^|[\s;{}(])function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^]*\)\s*(?::[^{]*)?$/,
  /(?:^|[\s;{}])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b[^]*|[^]*=>\s*)$/,
  /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^]*\)\s*(?::[^{]*)?$/,
];
const TOP_DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+|class\s+|enum\s+|interface\s+|type\s+)([A-Za-z_$][\w$]*)/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function']);

function headerName(header: string): string | null {
  for (const re of NAMED_HEADER) {
    const m = re.exec(header);
    if (m && !KEYWORDS.has(m[1])) return m[1];
  }
  return null;
}

/** Every seven-state read in `source`, each with the function it is in. */
export function sevenStateReads(source: string): ReadSite[] {
  // Code with strings, template text and comments blanked to spaces (offsets kept), so braces and names in prose or
  // in a literal neither open a scope nor count as a read.
  const code = source.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (code[k] !== '\n') code[k] = ' ';
  };
  const templates: number[] = []; // brace depth at which each open `${` resumes its template
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop - 1;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop - 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j;
    } else if (c === '`' || (c === '}' && templates.length > 0 && templates[templates.length - 1] === depth)) {
      if (c === '}') templates.pop();
      let j = i + 1;
      while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{'))
        j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      if (source[j] === '$') {
        templates.push(depth);
        i = j + 1; // past `${`: code again, at the same depth
      } else i = j;
    } else if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  const text = code.join('');

  // Braces: each `{` remembers the statement text before it, which names it when it opens a function body.
  const reads: ReadSite[] = [];
  const stack: { name: string | null; start: number }[] = [];
  let statementStart = 0;
  let topName = '(module)';
  let topStart = 0;
  const lineAt = (offset: number) => source.slice(0, offset).split('\n').length;
  const hits = [...text.matchAll(SEVEN_STATE_READ)].map((m) => ({ offset: m.index!, reader: m[1] ?? m[2] }));
  let h = 0;
  for (let i = 0; i <= text.length; i++) {
    while (h < hits.length && hits[h].offset === i) {
      const named = [...stack].reverse().find((s) => s.name !== null);
      reads.push({
        fn: named?.name ?? topName,
        fnStart: named?.start ?? topStart,
        reader: hits[h].reader,
        offset: i,
        line: lineAt(i),
      });
      h++;
    }
    const c = text[i];
    if (stack.length === 0 && (i === 0 || text[i - 1] === '\n')) {
      const m = TOP_DECL.exec(text.slice(i, text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i)));
      if (m) {
        topName = m[1];
        topStart = i;
      }
    }
    if (c === '{') {
      stack.push({ name: headerName(text.slice(statementStart, i)), start: i });
      statementStart = i + 1;
    } else if (c === '}') {
      stack.pop();
      statementStart = i + 1;
    } else if (c === ';') statementStart = i + 1;
  }
  return reads;
}

/** Whether the function a read sits in asks the display functions before that read. */
export const asksDisplayFirst = (source: string, site: ReadSite): boolean =>
  new RegExp(DISPLAY_CALL.source).test(source.slice(site.fnStart, site.offset));
