// Markdown readers shared by the two contract specs (`coordinator-contract.spec.ts` walks the
// frozen documents for internal consistency; `coordinator-counterexample.spec.ts` reads the same
// tables to keep its model from drifting away from the clauses it claims to implement). They live
// here rather than in either spec because a second copy of a table parser is exactly the kind of
// thing that drifts, and both specs assert against the same tables.
//
// Nothing outside the specs imports this.

/** Every `## n.` / `### n.m` heading number in a doc. */
export function headingNumbers(doc: string): Set<string> {
  const found = new Set<string>();
  for (const line of doc.split('\n')) {
    const m = /^#{2,3}\s+(\d+(?:\.\d+)?)[.\s]/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

/** The body of one section, from its heading up to the next heading of the same or higher level. */
export function section(doc: string, number: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s+${number.replace('.', '\\.')}[.\\s]`).test(l));
  if (start === -1) throw new Error(`section ${number} not found`);
  const level = /^(#+)/.exec(lines[start])![1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function isSeparator(cells: string[]): boolean {
  return cells.every((c) => /^:?-+:?$/.test(c) || c === '');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Cells of every `| … |` row in a chunk of markdown, minus the `---` separators. */
export function tableRows(md: string): string[][] {
  return md
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map(splitRow)
    .filter((cells) => !isSeparator(cells));
}

/**
 * Every table in a chunk, kept apart. A section that states a rule *and* a worked example holds
 * two tables, and reading them as one run of rows silently concatenates unrelated things.
 */
export function tables(md: string): string[][][] {
  const out: string[][][] = [];
  let current: string[][] | null = null;
  for (const line of md.split('\n')) {
    if (line.trim().startsWith('|')) {
      const cells = splitRow(line);
      if (isSeparator(cells)) continue;
      if (!current) {
        current = [];
        out.push(current);
      }
      current.push(cells);
    } else if (line.trim() !== '') {
      current = null;
    }
  }
  return out;
}

/** One column of a table, addressed by its header text rather than by index. */
export function column(rows: string[][], header: string): string[] {
  const at = rows[0].findIndex((h) => h.replace(/[`*]/g, '').trim() === header);
  if (at === -1) throw new Error(`no column headed "${header}" (have: ${rows[0].join(' / ')})`);
  return rows.slice(1).map((cells) => cells[at] ?? '');
}

/** Strip markdown emphasis and code ticks from a cell so it can be compared as a value. */
export function bare(cell: string): string {
  return cell.replace(/[`*]/g, '').trim();
}
