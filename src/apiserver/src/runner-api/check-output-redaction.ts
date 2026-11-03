import { REDACTED, redactSecrets } from '../common/secret-redaction';
import { MAX_CHECK_OUTPUT_TAIL } from '../projects/project-integration-job';

/**
 * What a check printed, made fit to store. Everything a runner reports of a check's output comes in through
 * `integration-job-relay.ts`, and these are what it goes through there: a log chunk, a result's tail and a failure's
 * detail alike, so that a runner already installed is held to the same rule as the next one, with no release to wait
 * for, and the item, the job row and the coordinator's turn say what the log says.
 *
 * THE RUNNER REDACTS TOO (`integrationOutputRedactor` in src/runner-go/integration_output_upload.go), AND IT HAS TO.
 * Only that machine knows its own token and the credentials in its environment, which no rule here can tell from any
 * other word, and what it takes out never leaves it. This door is for what a shape can tell, from whichever runner.
 */

/**
 * A URL's userinfo, up to the last `@` before the authority ends, read as the runner reads it
 * (`integrationURLCredential`). src/runner-go/testdata/integration-url-credentials.json is one table for the two, read
 * by both their tests, so neither can move alone.
 *
 * It runs before `redactSecrets`, whose own rule ends the authority at a `?` or a `#`: that one is right for text that
 * is mostly prose, and it lets `postgres://app:abc#123@db` through whole.
 *
 * `{0,31}` is the one difference, and nothing reads differently for it. No boundary is asked for before the scheme, so
 * a longer one is found from its last 32 characters and what is in front of those stays where it was. The bound is
 * there for the event loop: unbounded, a run of letters is scanned again from each of its letters, which RE2 does not
 * do to the runner and a 64 KiB chunk of them would do to this server.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s]+@/gi;

/**
 * How much of the front of a cut tail goes: the margin the runner keeps for its own cut (`integrationOutputCarryMax`).
 * A secret longer than this is redacted only when it arrives whole, which is the uploader's limit too.
 */
const CUT_TAIL_FRONT = 256;

/**
 * `text` as a row may hold it. NUL goes first, as PostgreSQL's text and jsonb hold none and a chunk carrying one was
 * refused with a 500, and because a secret one sits inside would not be recognised around it.
 */
export function redactCheckOutput(text: string): string {
  return redactSecrets(text.replaceAll('\0', '').replace(URL_USERINFO, `$1${REDACTED}@`)).text;
}

/**
 * A result's tail as an item and a job row hold it, at most `MAX_CHECK_OUTPUT_TAIL`.
 *
 * Redacted before it is cut: cut first, the front half of an address is left for no rule to recognise. That is still
 * what a runner from before this rule hands over, though, because it cuts its output at 16 KiB and sends it raw. A tail
 * that has reached the cap may start anywhere, the back half of a password included, with nothing in front of it to
 * say so, so its front goes. One that is short of the cap and was cut all the same (the runner takes NUL out after it
 * cuts) is not told apart; what it risks needs a NUL in the last 16 KiB and a cut inside an address, on a runner that
 * is about to be replaced. Only the last `MAX_CHECK_OUTPUT_TAIL` plus that front is read at all, whatever was sent.
 *
 * The rules can lengthen the text, so the slice below is reachable, and it counts UTF-16 units: half a surrogate pair
 * is what jsonb refuses a whole result for, and a runner would go on sending that result for as long as it lives.
 */
export function clipCheckTail(tail: string): string {
  const cut = Buffer.byteLength(tail, 'utf8') >= MAX_CHECK_OUTPUT_TAIL;
  const redacted = redactCheckOutput(tail.slice(-(MAX_CHECK_OUTPUT_TAIL + CUT_TAIL_FRONT)));
  const kept = (cut ? redacted.slice(CUT_TAIL_FRONT) : redacted).slice(-MAX_CHECK_OUTPUT_TAIL);
  const first = kept.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? kept.slice(1) : kept;
}

/**
 * The runner's own account of a failure, every string in it held to the same rule and everything else as it was: a
 * recipe that fails says why through the end of its output, and a push through git's, and both are quoted to the
 * coordinator from the item's payload.
 */
export function redactFailureDetail<T>(detail: T): T {
  if (detail == null) return detail;
  return JSON.parse(
    JSON.stringify(detail),
    (_key, value: unknown) => (typeof value === 'string' ? redactCheckOutput(value) : value),
  ) as T;
}
