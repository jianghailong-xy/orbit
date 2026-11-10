import { CallHandler, ExecutionContext, Injectable, NestInterceptor, UnprocessableEntityException } from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import { OwnerSecretsService, OWNER_SECRET_MIN_BYTES } from './owner-secrets.service';

/**
 * The write door (design docs/design/owner-request-secrets.md §7.2, level B): an agent's write that carries a secret
 * the runner holds — task evidence, a comment, notify, a session message, any other agent write — is refused
 * SECRET_IN_TEXT, naming the variable, and nothing is stored.
 *
 * Global, so a new runner route is covered without anyone remembering to. It costs one indexed read per write on a
 * runner-authenticated route, and decrypts only on a runner holding a grant. The runner protocol's own routes are left
 * out: what they carry is the runner's, already scrubbed at the event choke point, and refusing them would wedge a
 * spool or a turn instead of protecting anything.
 */
export const SECRET_IN_TEXT = 'SECRET_IN_TEXT';

const WRITES = new Set(['POST', 'PUT', 'PATCH']);

/** Runner protocol routes, after `/runner/`. */
const PROTOCOL = [
  /^heartbeat$/, /^events$/, /^claim$/, /^return$/, /^welcome$/, /^register$/, /^deregister$/, /^device\//,
  /^secret-grants\//, /^integration-jobs\//, /^wiki\/repo-ops\//, /-result$/, /^changesets$/, /^abandoned-checkouts$/,
  /^sessions\/import$/, /^sessions\/worktrees-removable$/,
  /^sessions\/[^/]+\/(events|turn-complete|finalize|end|activate-leases|release-leases|takeover-leases|diff|naming|background-wake|scheduled-wakeup|artifacts\/result|import-result|commit-result|merge-result|source\/pin|orchestration-credential)$/,
];

/** The forms of a value §5.4 scrubs, so the door refuses what the scrubber would have caught. */
export function secretForms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const forms = new Set<string>([
    value,
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
    bytes.toString('hex'),
    encodeURIComponent(value),
  ]);
  for (const line of value.split(/\r?\n/)) {
    if (Buffer.byteLength(line.trim(), 'utf8') >= OWNER_SECRET_MIN_BYTES) forms.add(line.trim());
  }
  return [...forms].filter((form) => form.length >= OWNER_SECRET_MIN_BYTES);
}

/** Every string in a body, keys included, depth-first. */
function strings(body: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 64) return out;
  if (typeof body === 'string') out.push(body);
  else if (Array.isArray(body)) for (const item of body) strings(item, out, depth + 1);
  else if (body && typeof body === 'object') {
    for (const [key, item] of Object.entries(body as Record<string, unknown>)) {
      out.push(key);
      strings(item, out, depth + 1);
    }
  }
  return out;
}

/** The variable or path whose value the body carries, or undefined. */
export function secretInBody(body: unknown, held: ReadonlyArray<{ name: string; value: string }>): string | undefined {
  const texts = strings(body).filter((t) => t.length >= OWNER_SECRET_MIN_BYTES);
  if (texts.length === 0) return undefined;
  for (const { name, value } of held) {
    const forms = secretForms(value);
    if (texts.some((text) => forms.some((form) => text.includes(form)))) return name;
  }
  return undefined;
}

@Injectable()
export class SecretWriteDoorInterceptor implements NestInterceptor {
  constructor(private readonly secrets: OwnerSecretsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{
      method: string; path?: string; url?: string; body?: unknown; runner?: { id: string; ownerId: string };
    }>();
    if (!req.runner || !WRITES.has(req.method) || req.body === undefined || req.body === null) return next.handle();
    const path = (req.path ?? req.url ?? '').split('?')[0];
    const at = path.indexOf('/runner/');
    const route = at >= 0 ? path.slice(at + '/runner/'.length) : '';
    if (PROTOCOL.some((pattern) => pattern.test(route))) return next.handle();
    const runner = req.runner;
    return from(this.secrets.valuesHeldBy(runner)).pipe(
      switchMap((held) => {
        const name = held.length > 0 ? secretInBody(req.body, held) : undefined;
        if (name) {
          throw new UnprocessableEntityException({
            code: SECRET_IN_TEXT,
            message: `this text contains the secret ${name}, which the owner gave for a command to use, not to be written down; nothing was stored. Remove it and send again`,
          });
        }
        return next.handle();
      }),
    );
  }
}
