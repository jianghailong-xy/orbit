import { Prisma } from '@prisma/client';

export interface RecordedRawQuery {
  text: string;
  values: readonly unknown[];
  invocation: 'tagged-template' | 'sql-object';
}

/**
 * Record either calling convention accepted by Prisma's `$queryRaw`:
 *
 * - ``client.$queryRaw`SELECT ... ${value}``` passes a `TemplateStringsArray` plus bindings;
 * - `client.$queryRaw(Prisma.sql`...`)` passes an already-composed `Prisma.Sql` object.
 *
 * Runnable-list reads use both shapes. Re-tagging the second shape as though it were the first
 * throws inside Prisma before the test reaches the SQL assertion, so focused doubles share this
 * adapter instead of each guessing which shape arrived.
 */
export function recordingQueryRaw(
  rows: (sql: string) => unknown[] | Promise<unknown[]> = () => [],
) {
  const statements: RecordedRawQuery[] = [];
  const $queryRaw = async (
    queryOrTemplate: TemplateStringsArray | Prisma.Sql,
    ...bindings: unknown[]
  ) => {
    const invocation = Array.isArray(queryOrTemplate) ? 'tagged-template' : 'sql-object';
    const query = invocation === 'tagged-template'
      ? Prisma.sql(queryOrTemplate as TemplateStringsArray, ...(bindings as never[]))
      : queryOrTemplate as Prisma.Sql;
    const statement: RecordedRawQuery = {
      text: query.text,
      values: [...query.values],
      invocation,
    };
    statements.push(statement);
    return rows(statement.text);
  };
  return { statements, $queryRaw };
}
