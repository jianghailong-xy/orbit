/**
 * The run-request receipt (migration 0137) as an in-memory row, for the unit fixtures that drive
 * `TasksService.execute` / `batchExecute` against a fake Prisma.
 *
 * Every door now opens a receipt before it does anything, so a double with no `$executeRaw` fails
 * inside the service under test — which reads as a product failure and is not one. This is the
 * receipt's actual behaviour, not a stub that always says "go ahead": it leases, it binds, it
 * completes, and a second call on the same token gets the first one's answer. A fixture that wants
 * to exercise a REPLAY therefore can, without a database.
 *
 * Test-only, and deliberately in `src/` rather than beside one spec: five fixtures need it, and a
 * sixth copy of "what the receipt does" is a sixth thing to keep in step with the migration.
 */
export interface FakeReceiptRow {
  fingerprint: string;
  status: 'OPEN' | 'BOUND' | 'COMPLETED';
  target: unknown;
  result: unknown;
  leaseHolder: string | null;
  attempt: number;
}

export interface FakeReceiptStore {
  rows: Map<string, FakeReceiptRow>;
  $executeRaw: (strings: TemplateStringsArray | unknown, ...values: unknown[]) => Promise<number>;
  $queryRaw: (strings: TemplateStringsArray | unknown, ...values: unknown[]) => Promise<unknown[]>;
}

const textOf = (strings: unknown): string =>
  Array.isArray((strings as { strings?: unknown[] })?.strings)
    ? ((strings as { strings: unknown[] }).strings as string[]).join(' ')
    : Array.isArray(strings)
      ? (strings as unknown as string[]).join(' ')
      : String(strings ?? '');

const valuesOf = (strings: unknown, rest: unknown[]): unknown[] =>
  Array.isArray((strings as { values?: unknown[] })?.values)
    ? (strings as { values: unknown[] }).values
    : rest;

/**
 * A receipt store keyed the way the row is: `(owner, door, token)`. Nothing here is keyed by
 * anything narrower, because that collision — two owners, or two tasks under one durable automatic
 * token — is precisely what the real key exists to prevent.
 */
export function fakeReceiptStore(): FakeReceiptStore {
  const rows = new Map<string, FakeReceiptRow>();
  const key = (owner: unknown, kind: unknown, token: unknown) => `${owner}|${kind}|${token}`;

  const store: FakeReceiptStore = {
    rows,
    $executeRaw: async (strings: unknown, ...rest: unknown[]) => {
      const sql = textOf(strings);
      const values = valuesOf(strings, rest);
      if (!/task_run_request/.test(sql)) return 0;
      if (/INSERT INTO "task_run_request"/.test(sql)) {
        const [owner, kind, token, fingerprint] = values as string[];
        const id = key(owner, kind, token);
        if (!rows.has(id)) {
          rows.set(id, {
            fingerprint, status: 'OPEN', target: null, result: null, leaseHolder: null, attempt: 0,
          });
        }
        return 1;
      }
      if (/SET "status" = 'BOUND'/.test(sql)) {
        const [target, owner, kind, token, holder, attempt] = values as [
          string, string, string, string, string, number,
        ];
        const row = rows.get(key(owner, kind, token));
        if (!row || row.status !== 'OPEN' || row.leaseHolder !== holder || row.attempt !== attempt) {
          return 0;
        }
        row.status = 'BOUND';
        row.target = JSON.parse(target);
        return 1;
      }
      if (/SET "status" = 'COMPLETED'/.test(sql)) {
        const [result, owner, kind, token, holder, attempt] = values as [
          string, string, string, string, string, number,
        ];
        const row = rows.get(key(owner, kind, token));
        if (!row || row.status === 'COMPLETED' || row.leaseHolder !== holder
          || row.attempt !== attempt) {
          return 0;
        }
        row.status = 'COMPLETED';
        row.result = JSON.parse(result);
        row.leaseHolder = null;
        return 1;
      }
      if (/SET "lease_holder" = NULL/.test(sql)) {
        const [owner, kind, token, holder, attempt] = values as [
          string, string, string, string, number,
        ];
        const row = rows.get(key(owner, kind, token));
        if (!row || row.status === 'COMPLETED' || row.leaseHolder !== holder
          || row.attempt !== attempt) {
          return 0;
        }
        row.leaseHolder = null;
        return 1;
      }
      if (/SET "lease_expires_at"/.test(sql)) {
        const [, owner, kind, token, holder, attempt] = values as [
          unknown, string, string, string, string, number,
        ];
        const row = rows.get(key(owner, kind, token));
        return row && row.status !== 'COMPLETED' && row.leaseHolder === holder
          && row.attempt === attempt ? 1 : 0;
      }
      return 0;
    },
    $queryRaw: async (strings: unknown, ...rest: unknown[]) => {
      const sql = textOf(strings);
      const values = valuesOf(strings, rest);
      if (!/task_run_request/.test(sql)) return [];
      if (/UPDATE "task_run_request"/.test(sql) && /RETURNING/.test(sql)) {
        // `[holder, leaseSeconds, owner, kind, token]` — the shape `leaseRunRequest` interpolates.
        const [holder, , owner, kind, token] = values as [string, unknown, string, string, string];
        const row = rows.get(key(owner, kind, token));
        if (!row || row.status === 'COMPLETED' || row.leaseHolder != null) return [];
        row.leaseHolder = holder;
        row.attempt += 1;
        return [{
          attempt: row.attempt, status: row.status, target: row.target, fingerprint: row.fingerprint,
        }];
      }
      const [owner, kind, token] = values as string[];
      const row = rows.get(key(owner, kind, token));
      if (!row) return [];
      if (/"status" = 'COMPLETED'/.test(sql)) {
        return row.status === 'COMPLETED' ? [{ result: row.result }] : [];
      }
      if (/"status" <> 'OPEN'/.test(sql)) {
        return row.status === 'OPEN' ? [] : [{ target: row.target }];
      }
      return [{
        fingerprint: row.fingerprint, status: row.status, target: row.target, result: row.result,
      }];
    },
  };
  return store;
}

/**
 * The same store, composed onto a double that has raw methods of its OWN.
 *
 * Several fixtures answer `$queryRaw` with a sweep's candidate row. Spreading the store over them
 * (or under them) makes one of the two disappear, and the failure is silent in the confusing
 * direction: the receipt read gets a candidate row back, sees no `fingerprint`, and reports the
 * token as naming a different request. So the two are composed rather than stacked — the receipt's
 * statements go to the receipt, and everything else to the double that was already there.
 */
export function withReceiptStore<T extends Record<string, unknown>>(
  double: T,
): T & Pick<FakeReceiptStore, '$executeRaw' | '$queryRaw' | 'rows'> {
  const store = fakeReceiptStore();
  const own = double as {
    $executeRaw?: (...args: unknown[]) => Promise<number>;
    $queryRaw?: (...args: unknown[]) => Promise<unknown[]>;
  };
  const mine = (strings: unknown) => /task_run_request/.test(textOf(strings));
  return {
    ...double,
    rows: store.rows,
    $executeRaw: async (strings: unknown, ...rest: unknown[]) =>
      mine(strings)
        ? store.$executeRaw(strings, ...rest)
        : ((await own.$executeRaw?.(strings, ...rest)) ?? 0),
    $queryRaw: async (strings: unknown, ...rest: unknown[]) =>
      mine(strings)
        ? store.$queryRaw(strings, ...rest)
        : ((await own.$queryRaw?.(strings, ...rest)) ?? []),
  } as T & Pick<FakeReceiptStore, '$executeRaw' | '$queryRaw' | 'rows'>;
}
