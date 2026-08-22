/**
 * The one answer the API gives when PostgreSQL threw a request's transaction away.
 *
 * A deadlock victim (`40P01`), a failed serialization (`40001`) and Prisma's `P2034` all mean the
 * same thing to a caller: the server rolled the whole unit of work back, nothing was written, and
 * the identical request is likely to succeed. That is a 503 with a code the caller can switch on
 * — not the 500 an unrecognised error becomes, which reads as "this request is broken" and makes
 * a client stop rather than send it again.
 *
 * It lives here because three consumers have to agree on it: the apiserver, which serves it; the
 * web client, which reads `code` off the body; and the CLI, which prints it. Anything derived
 * from the underlying database error — the SQL, the table, the parameters, the driver's own
 * wording — is deliberately absent: the body below is a constant, so there is nothing in it that
 * could carry a prompt, a credential or a schema detail out to a client.
 */

/** The stable product code. Callers switch on this, never on the message. */
export const TRANSIENT_DB_CONFLICT_CODE = 'TRANSIENT_DB_CONFLICT';

/** Fixed prose. It says what happened to the caller's data, and nothing about the server. */
export const TRANSIENT_DB_CONFLICT_MESSAGE =
  'the database rolled this request back to break a conflict with a concurrent write; nothing was saved, so the same request can be sent again';

/**
 * The `Retry-After` this answer carries, in seconds.
 *
 * One second, and a constant. A lock conflict clears in milliseconds, so a longer wait would be a
 * lie told to every client at once; and a number computed from how long the transaction actually
 * waited would be a measurement of the server's internal state, which is exactly what this
 * response is not allowed to leak. Delta-seconds rather than an HTTP-date for the same reason: a
 * date discloses the server's clock, and clients have to reconcile it with their own.
 */
export const TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS = 1;

/** The served body, in full. Every field is a constant — see the note above. */
export interface TransientDbConflictBody {
  statusCode: 503;
  error: 'Service Unavailable';
  code: typeof TRANSIENT_DB_CONFLICT_CODE;
  message: typeof TRANSIENT_DB_CONFLICT_MESSAGE;
  /**
   * That re-sending is the correct response, stated positively so a client does not have to infer
   * it from the status. A 503 alone can also mean "this server is going away"; this one cannot.
   */
  retryable: true;
  /** The same number as the `Retry-After` header, for clients that only read the body. */
  retryAfterSeconds: typeof TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS;
}

/** A fresh copy of the answer, so no caller can mutate the one every other caller serves. */
export function transientDbConflictBody(): TransientDbConflictBody {
  return {
    statusCode: 503,
    error: 'Service Unavailable',
    code: TRANSIENT_DB_CONFLICT_CODE,
    message: TRANSIENT_DB_CONFLICT_MESSAGE,
    retryable: true,
    retryAfterSeconds: TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS,
  };
}
