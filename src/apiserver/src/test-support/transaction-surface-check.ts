/**
 * The static half of the transaction-double invariant.
 *
 * `TransactionSurface` makes a double's shortfall a compile error wherever production and the
 * double meet through a declared type. Two places they do not meet that way remain, and this is
 * what covers them:
 *
 *   - a double reached through `$transaction` on a `PrismaService` the spec had to cast away, so
 *     no declared type survives between the two;
 *   - `$queryRaw`, where the drift was never a missing member but a body that assumed one of the
 *     two calling conventions — a shape no type can distinguish, since Prisma declares both.
 *
 * So this reads the source and answers the set question directly: what does production reach on a
 * transaction, what does its own surface declare, and what is in the first set but not the second.
 * A non-empty difference names every `delegate.method` in it, because "the double is incomplete"
 * is not a diagnosis and the next person still has to find out which member.
 */

/** One `delegate.method` pair reached on a transaction. */
export interface TransactionMemberUse {
  delegate: string;
  method: string;
}

export interface TransactionSurfaceReport {
  /** Members the file's own `TransactionSurface` declarations promise. */
  declared: TransactionMemberUse[];
  /** Members the audited region actually reaches. */
  used: TransactionMemberUse[];
  /** `used \ declared` — every entry here is a run-time `X is not a function` waiting to happen. */
  missing: TransactionMemberUse[];
  /** Production spellings that dodge a delegate instead of requiring it. */
  accommodations: string[];
}

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g;

/** Comments name delegates and methods in prose; only code may count as a use or a declaration. */
export function withoutComments(source: string): string {
  return source.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '$1');
}

/** `TransactionSurface<{ task: ['findMany'] }>` — every delegate and method it promises. */
export function declaredSurface(source: string): TransactionMemberUse[] {
  const code = withoutComments(source);
  const declared: TransactionMemberUse[] = [];
  for (const block of code.matchAll(/TransactionSurface<\{([\s\S]*?)\}>/g)) {
    for (const entry of block[1].matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
      for (const method of entry[2].matchAll(/'([^']+)'/g)) {
        declared.push({ delegate: entry[1], method: method[1] });
      }
    }
  }
  return declared;
}

/**
 * Every member the region reaches on one of `identifiers`.
 *
 * `delegates` is the generated client's own model list, so a property access that is not a Prisma
 * delegate — `tx.calls`, a local field — is not mistaken for one, and a model that was renamed
 * stops being recognised here at the same moment it stops existing.
 */
export function usedSurface(
  source: string,
  identifiers: readonly string[],
  delegates: ReadonlySet<string>,
): TransactionMemberUse[] {
  const code = withoutComments(source);
  const used = new Map<string, TransactionMemberUse>();
  const alternatives = identifiers.join('|');
  for (const hit of code.matchAll(new RegExp(`\\b(?:${alternatives})\\.(\\w+)\\.(\\w+)\\s*[(<]`, 'g'))) {
    if (!delegates.has(hit[1])) continue;
    used.set(`${hit[1]}.${hit[2]}`, { delegate: hit[1], method: hit[2] });
  }
  return [...used.values()].sort((a, b) => `${a.delegate}.${a.method}`.localeCompare(`${b.delegate}.${b.method}`));
}

/**
 * Production spellings that make a delegate optional.
 *
 * A real Prisma client always has every delegate, so `tx.task?.findMany`, `'task' in tx` and
 * `typeof tx.task` cannot be defending against anything the database can do — they can only be
 * defending against a test double that lacks it. Each one converts a missing delegate from a loud
 * failure into a silent skip, which is the false green this whole mechanism exists to prevent.
 */
export function accommodations(
  source: string,
  identifiers: readonly string[],
  delegates: ReadonlySet<string>,
): string[] {
  const code = withoutComments(source);
  const alternatives = identifiers.join('|');
  const found: string[] = [];
  for (const hit of code.matchAll(new RegExp(`\\b(?:${alternatives})\\?\\.(\\w+)`, 'g'))) {
    if (delegates.has(hit[1])) found.push(hit[0]);
  }
  for (const hit of code.matchAll(new RegExp(`\\b(?:${alternatives})\\.(\\w+)\\s*\\?\\.`, 'g'))) {
    if (delegates.has(hit[1])) found.push(hit[0].trim());
  }
  for (const hit of code.matchAll(new RegExp(`'(\\w+)'\\s+in\\s+(?:${alternatives})\\b`, 'g'))) {
    if (delegates.has(hit[1])) found.push(hit[0]);
  }
  for (const hit of code.matchAll(new RegExp(`typeof\\s+(?:${alternatives})\\.(\\w+)`, 'g'))) {
    if (delegates.has(hit[1])) found.push(hit[0]);
  }
  return found;
}

/** The whole audit for one production region. */
export function auditTransactionSurface(
  source: string,
  identifiers: readonly string[],
  delegates: ReadonlySet<string>,
  declarationSource = source,
): TransactionSurfaceReport {
  const declared = declaredSurface(declarationSource);
  const used = usedSurface(source, identifiers, delegates);
  const promised = new Set(declared.map((entry) => `${entry.delegate}.${entry.method}`));
  return {
    declared,
    used,
    missing: used.filter((entry) => !promised.has(`${entry.delegate}.${entry.method}`)),
    accommodations: accommodations(source, identifiers, delegates),
  };
}

/** The exact sentence a failing audit prints, so the difference names its members. */
export function describeMissing(label: string, missing: readonly TransactionMemberUse[]): string {
  const members = missing
    .map((entry) => (entry.delegate ? `${entry.delegate}.${entry.method}` : entry.method))
    .sort();
  return `${label}: transaction double surface is missing ${members.length} member(s): ${members.join(', ')}`;
}

/**
 * `$queryRaw` accepts a tagged template — a `TemplateStringsArray` followed by loose values — and
 * a composed `Prisma.Sql`, one object carrying `strings` and `values` together. A double that
 * reads `args[0]` as an array serves the first and throws `args[0].join is not a function` on the
 * second, and no type distinguishes them because Prisma declares an overload for each.
 *
 * So the rule is structural instead: a double may not take the arguments apart itself. It routes
 * them through `renderRawQuery`, which handles both and is tested against both.
 */
export function rawQueryHandRolling(source: string): string[] {
  const code = withoutComments(source);
  const found: string[] = [];
  for (const start of code.matchAll(/\$(?:queryRaw|executeRaw)\s*:/g)) {
    const body = balancedBody(code, start.index + start[0].length);
    if (/renderRawQuery/.test(body)) continue;
    found.push(...shapeAssumptions(body));
  }
  return found;
}

/**
 * A body assumes a calling convention when it takes the statement argument apart.
 *
 * Declaring the parameter and never reading it is not an assumption — such a double answers the
 * same way whichever convention arrives, which is exactly what is wanted. Reading `strings` off
 * it, indexing the argument list, or handing it to `Prisma.sql` is: each serves the tagged
 * template and throws `args[0].join is not a function` on a composed `Prisma.Sql`, or the reverse.
 */
function shapeAssumptions(body: string): string[] {
  const found: string[] = [];
  for (const hit of body.matchAll(/args\s*\[\s*\d+\s*\]|\.strings\b/g)) found.push(hit[0]);
  const signature = body.match(/^\s*(?:async\s*)?\(([^)]*)\)/);
  const first = signature?.[1].split(',')[0]?.trim().replace(/^\.\.\./, '').split(':')[0]?.trim();
  if (first && /^[A-Za-z_$][\w$]*$/.test(first)) {
    const consumed = new RegExp(`(?:Prisma\\.sql\\(\\s*${first}\\b|\\b${first}\\s*\\.(?:join|raw|strings|values)\\b)`, 'g');
    for (const hit of body.matchAll(consumed)) found.push(hit[0].trim());
  }
  return [...new Set(found)];
}

/** The value that follows a property key, read to the depth it opened at. */
function balancedBody(code: string, from: number): string {
  let depth = 0;
  for (let index = from; index < code.length; index += 1) {
    const character = code[index];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      if (depth === 0) return code.slice(from, index);
      depth -= 1;
    } else if (character === ',' && depth === 0) return code.slice(from, index);
  }
  return code.slice(from);
}
