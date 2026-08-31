type RawQueryShape = 'tagged-template' | 'prisma-sql';

export interface RenderedRawQuery {
  shape: RawQueryShape;
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
    return {
      shape: 'tagged-template',
      text: (statement as readonly string[]).join('?'),
      values: args.slice(1),
    };
  }
  if (statement != null && typeof statement === 'object') {
    const sql = statement as { strings?: unknown; values?: unknown };
    if (Array.isArray(sql.strings) && Array.isArray(sql.values)) {
      return {
        shape: 'prisma-sql',
        text: (sql.strings as readonly string[]).join('?'),
        values: sql.values as readonly unknown[],
      };
    }
  }
  throw new TypeError('unsupported $queryRaw test-double input');
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

  return {
    conversationTurn: {
      findMany: async (args: Record<string, unknown>) => {
        steerFinds.push(args);
        return steers.map((row) => ({ ...row }));
      },
      updateMany: async (args: Record<string, unknown>) => {
        steerWrites.push(args);
        return options.onConversationTurnUpdateMany
          ? options.onConversationTurnUpdateMany(args)
          : { count: steers.length };
      },
    },
    conversationTurnStartupFragment: {
      findMany: async (args: Record<string, unknown>) => {
        startupFinds.push(args);
        return startupFragments.map((row) => ({
          ...row,
          targetTurn: { ...row.targetTurn },
        }));
      },
      updateMany: async (args: Record<string, unknown>) => {
        startupWrites.push(args);
        return options.onStartupFragmentUpdateMany
          ? options.onStartupFragmentUpdateMany(args)
          : { count: startupFragments.length };
      },
    },
    calls: {
      steerFinds,
      steerWrites,
      startupFinds,
      startupWrites,
    },
  };
}
