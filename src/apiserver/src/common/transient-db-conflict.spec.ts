import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  Controller,
  HttpException,
  HttpServer,
  LoggerService,
  Module,
  Post,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import {
  TRANSIENT_DB_CONFLICT_CODE,
  TRANSIENT_DB_CONFLICT_MESSAGE,
  TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS,
  transientDbConflictBody,
  uuidToBase62,
} from '@orbit/shared';
import { PublicIdExceptionFilter } from './public-id.filter';
import { PublicIdInterceptor } from './public-id.interceptor';
import { withTransactionRetry } from './transaction-retry';
import { TransientDbConflictFilter } from './transient-db-conflict.filter';

/**
 * The contract for a database conflict that nothing caught: 503, `TRANSIENT_DB_CONFLICT`,
 * `retryable: true`, `Retry-After`.
 *
 * What is asserted here is the whole answer and nothing but the answer — the status, the body
 * field by field, the header, and the fact that none of it names the statement, the table, the
 * parameters or the row. That last part is the reason this is a contract test rather than a unit
 * test of the filter: the error a conflict arrives as carries the SQL and every bound parameter
 * in its message, so "we translate it to a 503" and "the 503 does not repeat it" are two
 * different claims, and only the second one is about what a client can see.
 *
 * The four shapes below are the four ways a write reaches PostgreSQL in this codebase, because
 * they wrap the error differently and a boundary that only understands one of them is a boundary
 * that 500s on the other three:
 *
 *   - an interactive `$transaction(async tx => …)` closure,
 *   - the array form `$transaction([…])`, where the batch is the transaction,
 *   - a single write with no explicit transaction at all,
 *   - a service that caught the failure and threw its own error with the Prisma one as `cause`.
 */

const CLIENT_VERSION = '7.9.1';

/**
 * Everything a leak would consist of, planted in the error the way PostgreSQL and Prisma really
 * plant it: the statement, the table, the bound parameters — which on this table are a user's
 * prompt — and a credential that happened to be in the row being written.
 *
 * Asserting on these strings is what makes "the response says nothing about the database" a test
 * rather than a promise. Every one of them is in the error that reaches the boundary.
 */
const SECRETS = [
  'UPDATE "conversation_turn"',
  'conversation_turn',
  'sk-ant-oat01-not-a-real-token',
  'summarise my private notes',
  '$1, $2, $3',
];

/** A driver message with all of it, exactly where Prisma puts the driver's own words. */
const LEAKY_DETAIL =
  'UPDATE "conversation_turn" SET "text" = $1, "token" = $2 WHERE "id" = $3 · params: ' +
  '($1, $2, $3) = ("summarise my private notes", "sk-ant-oat01-not-a-real-token", 42)';

/**
 * What Prisma 7 throws for a raw write PostgreSQL aborted: the top-level code is the generic
 * `P2010` and the SQLSTATE survives at `meta.driverAdapterError.cause.originalCode`. Captured
 * from a real 40001 in `transaction-retry.pg.spec.ts`; the same shape reaches this boundary.
 */
function abortedWrite(originalCode: string, originalMessage: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.$executeRawUnsafe()\` invocation:\n\nRaw query failed. ` +
      `Code: \`${originalCode}\`. Message: \`${originalMessage}\`\n${LEAKY_DETAIL}`,
    {
      code: 'P2010',
      clientVersion: CLIENT_VERSION,
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { originalCode, originalMessage, kind: 'TransactionWriteConflict' },
        },
      },
    },
  );
}

/** Prisma's own name for the same event, which is what a model write raises instead of a SQLSTATE. */
const writeConflict = () =>
  new Prisma.PrismaClientKnownRequestError(
    `Transaction failed due to a write conflict or a deadlock. Please retry your transaction\n${LEAKY_DETAIL}`,
    { code: 'P2034', clientVersion: CLIENT_VERSION },
  );

/** The failure Prisma could not map at all: no code anywhere, the SQLSTATE only in the text. */
const unmappedDeadlock = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Invalid `prisma.$executeRaw()` invocation:\n\nRaw query failed. ' +
      `Code: \`40P01\`. Message: \`deadlock detected\`\n${LEAKY_DETAIL}`,
    { clientVersion: CLIENT_VERSION },
  );

/** A permanent failure in the same wrapping, so "P2010 means transient" can never be the rule. */
const foreignKeyViolation = () =>
  abortedWrite('23503', 'insert or update on table "task" violates foreign key constraint');

// ----------------------------------------------------------------------------------------------
// The database, as the four call shapes see it.
// ----------------------------------------------------------------------------------------------

/**
 * A database that aborts its first `failures` writes.
 *
 * Not a mock of Prisma: what matters to the boundary is the SHAPE of the call the error escapes
 * from — a closure that was half-run, a batch that was never run, a lone statement — and every
 * one of those is a real code path here. The errors themselves are Prisma's own classes.
 */
class AbortingDatabase {
  writes = 0;

  constructor(
    private readonly error: () => Error,
    private readonly failures = Number.POSITIVE_INFINITY,
  ) {}

  /** One write, which the server throws away while it is still contended. */
  async write(): Promise<{ written: true }> {
    this.writes += 1;
    if (this.writes <= this.failures) throw this.error();
    return { written: true };
  }

  /** Both forms Prisma offers: a closure to run inside the transaction, or a batch that IS one. */
  async $transaction<T>(
    work: ((tx: AbortingDatabase) => Promise<T>) | Promise<unknown>[],
    _options?: unknown,
  ): Promise<T | unknown[]> {
    if (Array.isArray(work)) return Promise.all(work);
    return work(this);
  }
}

/** How many times each route's handler ran, so "the boundary does not retry" is observable. */
const handlerRuns = new Map<string, number>();
function ran(route: string): void {
  handlerRuns.set(route, (handlerRuns.get(route) ?? 0) + 1);
}

const REFUSAL_ROW = '01a02427-6cb5-7ae0-ae3c-ffe57116c33e';

@Controller('conflict')
class ConflictController {
  /** The interactive form: the closure had already written when the server rolled it back. */
  @Post('callback')
  async callback(): Promise<unknown> {
    ran('callback');
    const db = new AbortingDatabase(() => abortedWrite('40001', 'could not serialize access due to concurrent update'));
    return db.$transaction(async (tx) => tx.write());
  }

  /** The array form: the batch is the transaction, so the whole array is what was thrown away. */
  @Post('array')
  async array(): Promise<unknown> {
    ran('array');
    const db = new AbortingDatabase(() => abortedWrite('40P01', 'deadlock detected'));
    return db.$transaction([db.write(), db.write()]);
  }

  /** No transaction at all — one write, which PostgreSQL still picked as a conflict victim. */
  @Post('direct')
  async direct(): Promise<unknown> {
    ran('direct');
    return new AbortingDatabase(writeConflict).write();
  }

  /** A service that added its own context, which is how most of these actually arrive. */
  @Post('nested')
  async nested(): Promise<unknown> {
    ran('nested');
    try {
      await new AbortingDatabase(unmappedDeadlock).write();
    } catch (cause) {
      throw new Error('could not advance the project', { cause });
    }
    return {};
  }

  /**
   * The case that must NOT reach the boundary: a conflict the retry helper absorbed. The answer
   * is the work's answer, and the client never learns there was a conflict at all.
   */
  @Post('absorbed')
  async absorbed(): Promise<unknown> {
    ran('absorbed');
    const db = new AbortingDatabase(() => abortedWrite('40001', 'could not serialize access due to concurrent update'), 1);
    return withTransactionRetry(db as never, async (tx) => (tx as unknown as AbortingDatabase).write(), {
      sleep: async () => undefined,
    });
  }
}

@Controller('keep')
class UnchangedController {
  /** A business refusal that names the row in the way of it — the shape `AcceptanceRefusal` has. */
  @Post('business-conflict')
  businessConflict(): never {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'ACCEPTANCE_MISSING',
      message: 'the latest project acceptance concluded FAIL, not PASS',
      owner: 'USER',
      runId: REFUSAL_ROW,
    });
  }

  /** A refusal whose CAUSE is the conflict: somebody already decided this is the client's answer. */
  @Post('refusal-over-conflict')
  refusalOverConflict(): never {
    throw new ConflictException(
      { statusCode: 409, error: 'Conflict', code: 'TURN_ALREADY_CLOSED', message: 'that turn is closed' },
      { cause: abortedWrite('40001', 'could not serialize access due to concurrent update') },
    );
  }

  @Post('validation')
  validation(): never {
    throw new BadRequestException('taskId must be a public id');
  }

  /** A unique violation: a decision the data made, and the same one on every attempt. */
  @Post('unique')
  async unique(): Promise<unknown> {
    return new AbortingDatabase(
      () =>
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`seq`)', {
          code: 'P2002',
          clientVersion: CLIENT_VERSION,
          meta: { target: ['seq'] },
        }),
    ).write();
  }

  @Post('missing')
  async missing(): Promise<unknown> {
    return new AbortingDatabase(
      () =>
        new Prisma.PrismaClientKnownRequestError('An operation failed because it depends on one or more records that were required but not found', {
          code: 'P2025',
          clientVersion: CLIENT_VERSION,
        }),
    ).write();
  }

  @Post('foreign-key')
  async foreignKey(): Promise<unknown> {
    return new AbortingDatabase(foreignKeyViolation).write();
  }

  /** An endpoint that translates Prisma itself, as several do today. Its answer stands. */
  @Post('endpoint-translated')
  async endpointTranslated(): Promise<unknown> {
    try {
      return await new AbortingDatabase(
        () =>
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`slug`)', {
            code: 'P2002',
            clientVersion: CLIENT_VERSION,
          }),
      ).write();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'SLUG_TAKEN', message: 'that slug is taken' });
      }
      throw e;
    }
  }

  /** Something genuinely broken. A 500 is the honest answer and must stay one. */
  @Post('bug')
  bug(): never {
    throw new TypeError("Cannot read properties of undefined (reading 'id')");
  }
}

@Module({ controllers: [ConflictController, UnchangedController] })
class LiveModule {}

/** Nest's logger, captured: what the boundary writes is as much a leak surface as the body. */
const logged: string[] = [];
const capturingLogger: LoggerService = {
  log: () => undefined,
  error: (message: unknown) => logged.push(String(message)),
  warn: (message: unknown) => logged.push(String(message)),
  debug: () => undefined,
  verbose: () => undefined,
};

test('the answer to a database conflict, over real HTTP, on every shape a write takes', async (t) => {
  const app = await NestFactory.create(LiveModule, { logger: capturingLogger });
  app.setGlobalPrefix('api');
  // The interceptor is what parks the id-spelling boundary on the request; the filter behind this
  // one reads it. Registered here for the same reason main.ts registers it: without it, a refusal
  // body is judged with the boundary unknown and keeps its uuids.
  app.useGlobalInterceptors(new PublicIdInterceptor());
  // Verbatim from main.ts: the chain is what is under test, not the filter alone. Nest runs ONE
  // filter per exception, so a boundary that did not hand the rest on would silently take the id
  // rule off every refusal in the process.
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const post = async (route: string) => {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST' });
    const text = await response.text();
    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      text,
      body: JSON.parse(text) as Record<string, unknown>,
    };
  };

  /** The whole answer, asserted as one value: nothing extra, nothing missing, nothing derived. */
  const assertConflictAnswer = (answer: Awaited<ReturnType<typeof post>>, shape: string) => {
    assert.equal(answer.status, 503, `${shape}: a conflict is not the client's fault`);
    assert.deepEqual(answer.body, transientDbConflictBody(), `${shape}: the served body is the contract`);
    assert.equal(answer.body.code, TRANSIENT_DB_CONFLICT_CODE);
    assert.equal(answer.body.message, TRANSIENT_DB_CONFLICT_MESSAGE);
    assert.equal(answer.body.retryable, true);
    assert.equal(answer.retryAfter, String(TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS), `${shape}: Retry-After`);
    for (const secret of SECRETS) {
      assert.ok(!answer.text.includes(secret), `${shape}: the response repeats ${secret}`);
    }
    assert.ok(!/\bat .*\.(ts|js):\d+/.test(answer.text), `${shape}: the response carries a stack`);
  };

  await t.test('an interactive transaction the server rolled back', async () => {
    assertConflictAnswer(await post('conflict/callback'), 'callback');
    assert.equal(handlerRuns.get('callback'), 1, 'the boundary answered; it did not re-run the work');
  });

  await t.test('the array form, where the batch is the transaction', async () => {
    assertConflictAnswer(await post('conflict/array'), 'array');
  });

  await t.test('a single write with no transaction around it', async () => {
    assertConflictAnswer(await post('conflict/direct'), 'direct');
  });

  await t.test('a Prisma failure a service re-threw with its own message', async () => {
    assertConflictAnswer(await post('conflict/nested'), 'nested');
  });

  await t.test('a conflict the retry helper absorbed never reaches the boundary', async () => {
    const answer = await post('conflict/absorbed');
    assert.equal(answer.status, 201, 'the work succeeded on its second attempt; that is the answer');
    assert.deepEqual(answer.body, { written: true });
    assert.equal(answer.retryAfter, null);
  });

  await t.test('what the boundary logs names the reason and nothing about the row', () => {
    const lines = logged.filter((line) => line.includes(TRANSIENT_DB_CONFLICT_CODE));
    assert.equal(lines.length, 4, 'one line per conflict answered, and none for the absorbed one');
    for (const line of lines) {
      for (const secret of SECRETS) assert.ok(!line.includes(secret), `the log repeats ${secret}: ${line}`);
      assert.ok(!/\bat .*\.(ts|js):\d+/.test(line), `the log carries a stack: ${line}`);
    }
    // The evidence that decided it, which is a code from a closed set — and the route TEMPLATE,
    // which is the one spelling of the request that cannot carry an SSE or attachment token.
    assert.ok(lines.some((l) => l.includes('SERIALIZATION') && l.includes('evidence=40001')));
    assert.ok(lines.some((l) => l.includes('DEADLOCK') && l.includes('evidence=40P01')));
    assert.ok(lines.some((l) => l.includes('WRITE_CONFLICT') && l.includes('evidence=P2034')));
    assert.ok(lines.some((l) => l.includes('/conflict/callback')), `no route in: ${lines.join('\n')}`);
    assert.ok(!lines.some((l) => l.includes('?')), 'a query string reached the log');
  });

  await t.test('a business refusal is untouched, and still spells its row in base62', async () => {
    const answer = await post('keep/business-conflict');
    assert.equal(answer.status, 409);
    assert.equal(answer.body.code, 'ACCEPTANCE_MISSING');
    assert.equal(answer.body.runId, uuidToBase62(REFUSAL_ROW), 'the id exit still runs behind the boundary');
    assert.equal(answer.retryAfter, null);
  });

  await t.test('a refusal whose cause is a conflict is still the refusal', async () => {
    // Somebody already turned this into an answer for the client. Re-deciding it here would
    // replace a 409 that says which turn is closed with a 503 that says try again — and trying
    // again would refuse identically.
    const answer = await post('keep/refusal-over-conflict');
    assert.equal(answer.status, 409);
    assert.equal(answer.body.code, 'TURN_ALREADY_CLOSED');
  });

  await t.test('validation, unique, missing, foreign key and plain bugs keep their answers', async () => {
    assert.equal((await post('keep/validation')).status, 400);
    for (const route of ['keep/unique', 'keep/missing', 'keep/foreign-key', 'keep/bug']) {
      const answer = await post(route);
      assert.equal(answer.status, 500, `${route} became something other than a 500`);
      assert.notEqual(answer.body.code, TRANSIENT_DB_CONFLICT_CODE);
      assert.equal(answer.retryAfter, null);
    }
  });

  await t.test("an endpoint's own translation of Prisma still wins", async () => {
    const answer = await post('keep/endpoint-translated');
    assert.equal(answer.status, 409);
    assert.equal(answer.body.code, 'SLUG_TAKEN');
  });
});

// ----------------------------------------------------------------------------------------------
// The one case a socket cannot show: a conflict on a response that has already begun.
// ----------------------------------------------------------------------------------------------

/** An `ArgumentsHost` shaped like the one Nest hands a global filter. */
function hostWith(request: Record<string, unknown>, response: unknown): ArgumentsHost {
  return {
    getType: () => 'http',
    getClass: () => null,
    getArgByIndex: (i: number) => (i === 0 ? request : response),
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

test('a conflict under a response that already started does not try to set a header', () => {
  // An SSE stream writes its status line the moment it opens, and a write it makes ten minutes
  // later can still lose a lock cycle. `setHeader` then throws ERR_HTTP_HEADERS_SENT, which would
  // turn a handled conflict into an unhandled crash inside the error handler.
  const handed: unknown[] = [];
  const adapter = {
    isHeadersSent: () => true,
    setHeader: () => assert.fail('the boundary set a header on a response that had already begun'),
  } as unknown as HttpServer;
  const next = { catch: (exception: unknown) => handed.push(exception) };

  new TransientDbConflictFilter(next, adapter).catch(
    abortedWrite('40P01', 'deadlock detected'),
    hostWith({ method: 'GET' }, {}),
  );

  assert.equal(handed.length, 1, 'the response is still answered');
  assert.equal((handed[0] as HttpException).getStatus(), 503);
});

test('everything the boundary does not own is handed on as the identical object', () => {
  const handed: unknown[] = [];
  const adapter = { isHeadersSent: () => false, setHeader: () => undefined } as unknown as HttpServer;
  const filter = new TransientDbConflictFilter({ catch: (e: unknown) => handed.push(e) }, adapter);
  const host = hostWith({ method: 'POST' }, {});

  const refusal = new ConflictException('that turn is closed');
  const bug = new TypeError('undefined is not a function');
  const permanent = foreignKeyViolation();
  for (const exception of [refusal, bug, permanent]) filter.catch(exception, host);

  // Identity, not equality: a boundary that rebuilt the exception would strip whatever the layer
  // below reads off it — the response object, the cause, the class an `instanceof` matches.
  assert.deepEqual(handed, [refusal, bug, permanent]);
});

// ----------------------------------------------------------------------------------------------
// The wiring, which nothing else would notice the loss of.
// ----------------------------------------------------------------------------------------------

/** The source tree, not the compiled one: this reads what is written, from `build/common`. */
const SRC = path.resolve(__dirname, '../..', 'src');

test('the boundary is registered, in front of the id filter rather than beside it', () => {
  const main = readFileSync(path.join(SRC, 'main.ts'), 'utf8');
  assert.match(
    main,
    /useGlobalFilters\(\s*new TransientDbConflictFilter\(new PublicIdExceptionFilter\(/,
    'the conflict boundary is gone from main.ts — every 40P01 that escapes a service is a 500 again',
  );
  // Chained, not listed: Nest reverses the global filters and runs the FIRST whose @Catch matches,
  // so a second catch-all would replace the id filter instead of running before it.
  assert.doesNotMatch(main, /useGlobalFilters\([^)]*,\s*new PublicIdExceptionFilter/, 'registered beside, not chained');
});

test('no service keeps its own private answer for a transient conflict', () => {
  // The point of one boundary is that there is one. A service that recognised 40001 itself would
  // be a second policy: a different status, a different code, and no way to tell from the outside
  // which one answered. The shared classifier is the only place these three codes are spelled.
  const allowed = new Set([
    path.join(SRC, 'common', 'transaction-retry.ts'),
    path.join(SRC, 'common', 'transient-db-conflict.filter.ts'),
  ]);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        // The lock-order fixtures exist to PRODUCE these SQLSTATEs; they answer no request.
        if (entry !== 'deadlock') walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts') || allowed.has(full)) continue;
      if (/'40P01'|'40001'|'P2034'/.test(readFileSync(full, 'utf8'))) offenders.push(path.relative(SRC, full));
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], 'these files answer a transient conflict themselves; use the shared boundary');
});
