/**
 * What a session row answers to the failure-kind filters of common/run-failure-kind-filter.ts, evaluated the way
 * Postgres would, NULLs included: a test double of `session.groupBy` reads the clause its caller asked rather than
 * assuming which query it is. Only the operators those filters use are understood (OR, AND, NOT, `failureKind` null /
 * in / notIn, `error` null / insensitive contains, `accountHealthEffect` null / not null); anything else is refused, so a filter that grows a new shape fails
 * its tests instead of being read as true.
 */
export interface FailureRow {
  error: string | null;
  failureKind?: string | null;
  /** What account health did with the run (session.account_health_effect); absent is none. */
  accountHealthEffect?: string | null;
}

type Truth = boolean | null;

const not = (value: Truth): Truth => (value === null ? null : !value);
const and = (values: Truth[]): Truth =>
  values.some((v) => v === false) ? false : values.some((v) => v === null) ? null : true;
const or = (values: Truth[]): Truth =>
  values.some((v) => v === true) ? true : values.some((v) => v === null) ? null : false;

function evaluate(where: Record<string, unknown>, row: FailureRow): Truth {
  const parts: Truth[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR') parts.push(or((value as Record<string, unknown>[]).map((w) => evaluate(w, row))));
    else if (key === 'AND') parts.push(and((value as Record<string, unknown>[]).map((w) => evaluate(w, row))));
    else if (key === 'NOT') parts.push(not(evaluate(value as Record<string, unknown>, row)));
    else if (key === 'failureKind') {
      const kind = row.failureKind ?? null;
      if (value === null) parts.push(kind === null);
      else if ('in' in (value as object)) parts.push(kind === null ? null : (value as { in: string[] }).in.includes(kind));
      else if ('notIn' in (value as object)) parts.push(kind === null ? null : !(value as { notIn: string[] }).notIn.includes(kind));
      else throw new Error(`failure-kind double: unknown failureKind filter ${JSON.stringify(value)}`);
    } else if (key === 'error') {
      if (value === null) parts.push(row.error === null);
      else if ('contains' in (value as object)) {
        const marker = (value as { contains: string }).contains.toLowerCase();
        parts.push(row.error === null ? null : row.error.toLowerCase().includes(marker));
      } else throw new Error(`failure-kind double: unknown error filter ${JSON.stringify(value)}`);
    } else if (key === 'accountHealthEffect') {
      const effect = row.accountHealthEffect ?? null;
      if (value === null) parts.push(effect === null);
      else if (JSON.stringify(value) === JSON.stringify({ not: null })) parts.push(effect !== null);
      else throw new Error(`failure-kind double: unknown accountHealthEffect filter ${JSON.stringify(value)}`);
    } else throw new Error(`failure-kind double: unknown key ${key}`);
  }
  return and(parts);
}

/** Whether `row` is selected by `where` (a WHERE keeps only rows for which it is true, not NULL). */
export function matchesFailureFilter(where: unknown, row: FailureRow): boolean {
  return evaluate(where as Record<string, unknown>, row) === true;
}

/** The failure-kind clause of a `session.groupBy` where: the element of its AND that names failureKind. */
export function failureClauseOf(where: { AND?: unknown[] }): unknown {
  const clause = (where.AND ?? []).find((c) => JSON.stringify(c).includes('"failureKind"'));
  if (!clause) throw new Error('failure-kind double: the query carries no failure-kind clause');
  return clause;
}
