/**
 * For a spec that is about what a daemon route decides, and so calls it over plain HTTP without a link gateway in front
 * of it. Importing this lifts the refusal RunnerApiController's routes answer such a call with
 * (runner-api/runner-link-required.ts), in this process and in any apiserver it spawns with its environment, so the
 * handler is what answers. The same handlers serve the link: the gateway forwards each of its calls to them, over the
 * apiserver's internal listener.
 *
 * Production has no such thing: an HTTPS call to these routes is refused. runner-link-required.spec.ts and its pg spec,
 * which do not import this, are where that is tried, and runner-link-call.pg.spec.ts is where a call comes over the link.
 */
import { RunnerLinkRequiredInterceptor } from '../runner-api/runner-link-required';

RunnerLinkRequiredInterceptor.prototype.intercept = (_context, next) => next.handle();

const preload = `--require ${__filename}`;
if (!process.env.NODE_OPTIONS?.includes(preload)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
}
