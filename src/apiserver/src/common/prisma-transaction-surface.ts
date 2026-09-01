/**
 * The transaction members a function actually needs, spelled in Prisma's own types.
 *
 * A parameter typed `Prisma.TransactionClient` says "this may touch any of the client's delegates".
 * That is both untrue of every function that has one and unfalsifiable: nothing can check a
 * hand-written double against it, so the only way a delegate the double never grew surfaces is
 * `X is not a function`, at run time, inside whichever acceptance happened to walk the path.
 *
 * A `TransactionSurface` is the same client narrowed to named delegates and named methods, and it
 * closes that gap from both sides at once:
 *
 *   - production may only reach the members its own declaration lists, so a call to an undeclared
 *     delegate is a compile error at the call site rather than a run-time surprise;
 *   - a double is checked member by member against Prisma's real declarations, so a missing or
 *     misspelled method is a compile error that names it.
 *
 * The member types are Prisma's throughout — nothing is restated here, so there is no second copy
 * to drift. Widening a surface is a deliberate one-line edit that immediately obliges every double
 * declared against it to grow the same member.
 */

import type { Prisma } from '@prisma/client';

/** Every model delegate on the transaction client. The `$`-prefixed helpers are not models. */
export type PrismaDelegateName =
  Exclude<Extract<keyof Prisma.TransactionClient, string>, `$${string}` | 'clientVersion'>;

/**
 * `{ task: ['findMany'] }` — delegate names and method names are both checked against the
 * generated client, so a model that was renamed or a method that never existed fails to compile
 * here rather than at the call that needed it.
 */
export type TransactionSurfaceSpec = {
  readonly [K in PrismaDelegateName]?: readonly (keyof Prisma.TransactionClient[K])[];
};

/** A spec resolved back into Prisma's own member types. */
export type TransactionSurface<S extends TransactionSurfaceSpec> = {
  readonly [K in Extract<keyof S, PrismaDelegateName>]-?: Pick<
    Prisma.TransactionClient[K],
    Extract<S[K] extends readonly (infer M)[] ? M : never, keyof Prisma.TransactionClient[K]>
  >;
};
