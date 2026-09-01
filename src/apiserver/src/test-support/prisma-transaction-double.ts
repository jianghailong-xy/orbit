import type {
  CurrentWorkStartupTransaction,
  CurrentWorkSteerTransaction,
} from '../sessions/current-work-delivery';

type RawQueryShape = 'tagged-template' | 'prisma-sql';

export interface RenderedRawQuery {
  shape: RawQueryShape;
  /** The literal fragments, so a double that has to speak a dialect can build its own text. */
  strings: readonly string[];
  /** The fragments joined on `?`, which is enough for every double that only matches on SQL. */
  text: string;
  values: readonly unknown[];
}

/**
 * Render the two calling conventions Prisma accepts for `$queryRaw`.
 *
 * A tagged template passes its literal array followed by the bound values. A composed
 * `Prisma.sql` statement passes one object containing both `strings` and `values`. Transaction
 * doubles must preserve that distinction: treating the object as an array is the historical
 * `args[0].join is not a function` drift this helper is intended to make impossible.
 */
export function renderRawQuery(args: readonly unknown[]): RenderedRawQuery {
  const statement = args[0];
  if (
    Array.isArray(statement)
    && Array.isArray((statement as unknown as { raw?: unknown }).raw)
  ) {
    const flat = flattenSql(statement as readonly string[], args.slice(1));
    return {
      shape: 'tagged-template',
      strings: flat.strings,
      text: flat.strings.join('?'),
      values: flat.values,
    };
  }
  const sql = asSql(statement);
  if (sql) {
    const flat = flattenSql(sql.strings, sql.values);
    return {
      shape: 'prisma-sql',
      strings: flat.strings,
      text: flat.strings.join('?'),
      values: flat.values,
    };
  }
  throw new TypeError('unsupported $queryRaw test-double input');
}

/** A composed statement, recognised by carrying both halves of itself. */
function asSql(value: unknown): { strings: readonly string[]; values: readonly unknown[] } | null {
  if (value == null || typeof value !== 'object') return null;
  const candidate = value as { strings?: unknown; values?: unknown };
  return Array.isArray(candidate.strings) && Array.isArray(candidate.values)
    ? { strings: candidate.strings as readonly string[], values: candidate.values as readonly unknown[] }
    : null;
}

/**
 * Splice composed statements into their host, the way Prisma's own `Sql` constructor does.
 *
 * A bound value may itself be a statement — `Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))`
 * is the ordinary way to build an `IN` list — and Prisma folds its fragments into the surrounding
 * text rather than binding it as a parameter. A double that skipped this step reported text with
 * the nested fragments missing, so a spec counting `::run_status` in the statement production
 * actually issues saw none: a silent disagreement with the real client, which is the false green
 * this helper exists to rule out.
 */
function flattenSql(
  strings: readonly string[],
  values: readonly unknown[],
): { strings: readonly string[]; values: readonly unknown[] } {
  const outStrings: string[] = [];
  const outValues: unknown[] = [];
  let pending = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    const nested = asSql(values[index]);
    if (nested) {
      const flat = flattenSql(nested.strings, nested.values);
      pending += flat.strings[0] ?? '';
      for (let inner = 0; inner < flat.values.length; inner += 1) {
        outStrings.push(pending);
        outValues.push(flat.values[inner]);
        pending = flat.strings[inner + 1] ?? '';
      }
    } else {
      outStrings.push(pending);
      outValues.push(values[index]);
      pending = '';
    }
    pending += strings[index + 1] ?? '';
  }
  outStrings.push(pending);
  return { strings: outStrings, values: outValues };
}

/**
 * The owner-scoped failure-coordination rollup every task-detail read issues.
 *
 * It is a plain read, but a double that labels unrecognized statements by their lock clause — or
 * as a lock outright — silently reclassifies it and breaks exact call-order assertions in specs
 * that never meant to say anything about it. Recognizing it by table keeps that classification
 * honest without teaching each double the whole statement.
 */
export function isFailureCoordinationRead(sql: string): boolean {
  return /FROM failure_continuation_obligation\b/.test(sql);
}

/**
 * Bind one hand-written body to the exact member type Prisma declares for it.
 *
 * Prisma's delegate methods return a branded `PrismaPromise`, so a plain `async` function is not
 * assignable to one; without this the only way to populate a double is a cast, and a cast on the
 * whole object is precisely what let five separate delegates go missing without a compile error.
 *
 * The relaxation here is deliberately the narrowest that works. It applies to the BODY only: the
 * property's name, its presence, and its declared type all still come from
 * `Prisma.TransactionClient`, and the arguments the body receives are Prisma's own argument type.
 * Deleting a method, misspelling one, or declaring one Prisma does not have therefore all remain
 * compile errors that name the member.
 */
export function delegateMethod<F extends (...args: never[]) => unknown>(
  implementation: (args: PrismaMethodArgs<F>) => unknown,
): F {
  return implementation as unknown as F;
}

/** The argument type Prisma declares for a delegate method, with its type parameter at its bound. */
export type PrismaMethodArgs<F> = F extends (args: infer A, ...rest: never[]) => unknown ? A : never;

/** A hand-written stand-in for surface `S`: the same members, with bodies free to return plainly. */
export type TransactionDoubleOf<S> = {
  [K in keyof S]: { [M in keyof S[K]]: (args: PrismaMethodArgs<S[K][M]>) => unknown };
};

/**
 * Accept a hand-written double and hand back the surface it stands in for.
 *
 * This is the replacement for `as unknown as Prisma.TransactionClient`. That cast asserted the
 * object was a whole Prisma client, which was never true and — because it erased every member —
 * meant a double missing the one delegate production had just started calling still compiled, and
 * only announced itself as `X is not a function` half an hour into an acceptance.
 *
 * Here the argument is checked member for member against `S`: a missing method, a misspelled one,
 * or one Prisma does not declare is a compile error naming it, and the arguments each body
 * receives are Prisma's own argument types. Only the return value is left free, because Prisma's
 * results are branded and generic in the caller's `select`.
 */
export function transactionDouble<S>(members: TransactionDoubleOf<S>): S {
  return members as unknown as S;
}

type UpdateResult = { count: number };
type UpdateHook = (args: Record<string, unknown>) => UpdateResult | Promise<UpdateResult>;

export interface CurrentWorkSteerCandidate extends Record<string, unknown> {
  id: string;
  targetTurnId: string | null;
  status: 'PENDING' | 'IN_FLIGHT';
}

export interface CurrentWorkStartupCandidate extends Record<string, unknown> {
  id: string;
  targetTurnId: string;
  deliveredAt: Date | null;
  targetTurn: { status: 'PENDING' | 'IN_FLIGHT' };
}

interface CurrentWorkDoubleOptions {
  steers?: readonly CurrentWorkSteerCandidate[];
  startupFragments?: readonly CurrentWorkStartupCandidate[];
  onConversationTurnUpdateMany?: UpdateHook;
  onStartupFragmentUpdateMany?: UpdateHook;
}

/**
 * Complete test delegates for a transaction that may enter
 * `terminalizeUndeliveredCurrentWork`. Empty arrays model the no-candidate path explicitly; rows
 * model the receipt-writing path. Both update delegates always exist even when an empty read means
 * production correctly never calls them.
 *
 * The two delegates are typed as the surfaces production declares, not as free object literals, so
 * the compiler — not a half-hour acceptance — is what reports a method this double stopped
 * supplying. Widening either surface in `current-work-delivery.ts` fails to compile here until the
 * same member is added below, which is the whole invariant this helper exists to hold.
 */
export function currentWorkTerminalizationDouble(
  options: CurrentWorkDoubleOptions = {},
) {
  const steerFinds: Record<string, unknown>[] = [];
  const steerWrites: Record<string, unknown>[] = [];
  const startupFinds: Record<string, unknown>[] = [];
  const startupWrites: Record<string, unknown>[] = [];
  const steers = [...(options.steers ?? [])];
  const startupFragments = [...(options.startupFragments ?? [])];
  const recorded = (args: unknown) => (args ?? {}) as Record<string, unknown>;

  const conversationTurn: CurrentWorkSteerTransaction['conversationTurn'] = {
    findMany: delegateMethod((args) => {
      steerFinds.push(recorded(args));
      return steers.map((row) => ({ ...row }));
    }),
    updateMany: delegateMethod((args) => {
      const seen = recorded(args);
      steerWrites.push(seen);
      return options.onConversationTurnUpdateMany
        ? options.onConversationTurnUpdateMany(seen)
        : { count: steers.length };
    }),
  };

  const conversationTurnStartupFragment:
  CurrentWorkStartupTransaction['conversationTurnStartupFragment'] = {
    findMany: delegateMethod((args) => {
      startupFinds.push(recorded(args));
      return startupFragments.map((row) => ({
        ...row,
        targetTurn: { ...row.targetTurn },
      }));
    }),
    updateMany: delegateMethod((args) => {
      const seen = recorded(args);
      startupWrites.push(seen);
      return options.onStartupFragmentUpdateMany
        ? options.onStartupFragmentUpdateMany(seen)
        : { count: startupFragments.length };
    }),
  };

  return {
    conversationTurn,
    conversationTurnStartupFragment,
    calls: {
      steerFinds,
      steerWrites,
      startupFinds,
      startupWrites,
    },
  };
}
