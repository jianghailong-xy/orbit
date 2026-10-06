import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { generateToken, sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { SharedRateLimiter } from '../shared/public-surface.guard';
import { AuthService } from './auth.service';
import type { GoogleClient } from './google-auth.controller';
import {
  GoogleOAuthClient,
  s256,
  verifyGoogleIdTokenClaims,
  type VerifiedGoogleIdentity,
} from './google-oauth.client';
import { GOOGLE, googleRedirectUri, SignInProvidersService } from './sign-in-providers.service';

/** How long a started sign-in may take to come back from Google (§4.1). */
export const GOOGLE_FLOW_TTL_MS = 10 * 60_000;
/** How long the callback's ticket may wait for its exchange (§4.2 step 6). */
export const GOOGLE_TICKET_TTL_MS = 2 * 60_000;
/**
 * How many sign-ins may be waiting on Google at once, across the deployment (§7.4). /start writes a
 * row for anyone who asks, so the table is bounded here rather than by the rate limit alone: past it
 * a start is refused 503 until rows end or are swept. Far above what people signing in reach — each
 * is one row for at most ten minutes — so only a flood meets it.
 */
export const GOOGLE_PENDING_FLOW_CAP = 10_000;
/**
 * Starts and exchanges one address may make a minute (§7.4), each door its own budget. A person
 * makes one of each per sign-in.
 */
export const GOOGLE_START_RATE_LIMIT = { max: 30, windowMs: 60_000 };
export const GOOGLE_EXCHANGE_RATE_LIMIT = { max: 30, windowMs: 60_000 };
/** The longest `client_state` a native client may have handed back. */
export const GOOGLE_CLIENT_STATE_MAX = 512;

/** A PKCE S256 challenge: 43 base64url characters, the unpadded sha256 (RFC 7636 §4.2). */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** A PKCE code verifier (RFC 7636 §4.1). */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** What a sign-in is for: signing in, or linking Google to the account already signed in (§5.3). */
export type GoogleIntent = 'LOGIN' | 'LINK';

/** The answers a callback sends the client back with (§4.2), besides a ticket. */
export type GoogleCallbackError =
  | 'GOOGLE_FLOW_EXPIRED'
  | 'GOOGLE_CANCELLED'
  | 'GOOGLE_EXCHANGE_FAILED'
  | 'GOOGLE_EMAIL_UNVERIFIED'
  | 'GOOGLE_NOT_CONFIGURED';

/** Who the callback answers: the client that started the flow, as the flow recorded it. */
export interface GoogleReturnTo {
  client: GoogleClient;
  intent: GoogleIntent;
  clientState: string | null;
}

/** What a callback came to: a ticket for the client to exchange, or why there is none. */
export type GoogleCallbackOutcome = { to: GoogleReturnTo; ticket: string } | { to: GoogleReturnTo; error: GoogleCallbackError };

/**
 * A callback for a flow this server cannot find — never started, already ended, or swept — has no
 * record of which client started it, and nothing the request says is taken in its place (§4.2), so
 * it goes back to the Web login page.
 */
const UNKNOWN_FLOW: GoogleReturnTo = { client: 'web', intent: 'LOGIN', clientState: null };

/** What the exchange reads of the row it deletes. */
interface RedeemedFlow {
  intent: string;
  clientChallenge: string;
  ticketExpiresAt: Date | null;
  claims: unknown;
}

/** Two digests in one encoding — sha256 hex, or an S256 challenge — compared in constant time. */
function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The identity a flow kept, as the callback wrote it; null for anything else. */
function identityOf(claims: unknown): VerifiedGoogleIdentity | null {
  if (claims === null || typeof claims !== 'object') return null;
  const value = claims as Partial<VerifiedGoogleIdentity>;
  if (typeof value.sub !== 'string' || value.sub === '' || typeof value.email !== 'string' || value.emailVerified !== true) {
    return null;
  }
  return {
    sub: value.sub,
    email: value.email,
    emailVerified: true,
    hd: typeof value.hd === 'string' ? value.hd : null,
    name: typeof value.name === 'string' ? value.name : null,
  };
}

const mismatch = () =>
  new BadRequestException({
    code: 'GOOGLE_FLOW_MISMATCH',
    message: 'This Google sign-in has expired, was already used, or was started elsewhere — sign in again',
  });

/**
 * Signing in with Google (docs/google-sign-in-design.md §4): the start that sends a browser to Google,
 * the callback that verifies what Google sent back and hands the client a one-time ticket, and the
 * exchange of that ticket for an Orbit session. The callback settles nothing: the session is issued
 * only to whoever presents the ticket together with the verifier of the challenge the start was given.
 *
 * What holds the flow together, each a column of `oauth_login_flow` (migration 0391):
 *  - `state`: one use, ten minutes. A callback finds its flow by the state's hash; the first callback
 *    to present it ends the flow's PENDING life whatever the outcome, and a flow that is not PENDING
 *    or is past its ten minutes is GOOGLE_FLOW_EXPIRED.
 *  - the binding cookie: a callback from a browser without the cookie the start set is
 *    GOOGLE_FLOW_EXPIRED, so a flow someone else started cannot be finished in this browser.
 *  - `nonce` and Google's side of PKCE, which the code exchange and the claims check carry.
 *  - the ticket: 256 bits, kept as its hash, two minutes, burned the first time it is presented —
 *    whether or not the verifier that comes with it is right.
 * No Google token is kept: the ID token's claims are verified and only the identity is written.
 */
@Injectable()
export class GoogleLoginService {
  private readonly log = new Logger('GoogleSignIn');
  private readonly startLimiter = new SharedRateLimiter(
    GOOGLE_START_RATE_LIMIT,
    'too many Google sign-ins started from this address, slow down',
  );
  private readonly exchangeLimiter = new SharedRateLimiter(
    GOOGLE_EXCHANGE_RATE_LIMIT,
    'too many Google sign-in tickets presented from this address, slow down',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly signIn: SignInProvidersService,
    private readonly google: GoogleOAuthClient,
    private readonly auth: AuthService,
  ) {}

  /**
   * §4.1: open a flow for `client` and answer where to send the browser, with the binding cookie's
   * value. Null while Google sign-in is off, before anything is checked or written: the client is
   * sent back with GOOGLE_NOT_CONFIGURED, as before there was a flow.
   */
  async start(input: {
    client: GoogleClient;
    codeChallenge?: unknown;
    clientState?: unknown;
    visitor: string;
  }): Promise<{ authorizationUrl: string; binding: string } | null> {
    const clientId = await this.signIn.googleClientId();
    if (clientId === null) return null;
    const { codeChallenge, clientState } = input;
    if (typeof codeChallenge !== 'string' || !S256_CHALLENGE.test(codeChallenge)) {
      throw new BadRequestException('code_challenge must be an S256 challenge: 43 base64url characters');
    }
    if (clientState !== undefined && (typeof clientState !== 'string' || clientState.length > GOOGLE_CLIENT_STATE_MAX)) {
      throw new BadRequestException(`client_state must be one string of at most ${GOOGLE_CLIENT_STATE_MAX} characters`);
    }
    this.startLimiter.take(input.visitor);
    await this.sweep();
    const pending = await this.prisma.oAuthLoginFlow.count({ where: { status: 'PENDING', expiresAt: { gt: new Date() } } });
    if (pending >= GOOGLE_PENDING_FLOW_CAP) {
      throw new ServiceUnavailableException({
        code: 'GOOGLE_SIGN_IN_BUSY',
        message: 'Too many Google sign-ins are in progress on this server — try again in a few minutes',
      });
    }
    const state = generateToken(32);
    const nonce = generateToken(32);
    const binding = generateToken(32);
    const providerCodeVerifier = generateToken(32);
    await this.prisma.oAuthLoginFlow.create({
      data: {
        provider: GOOGLE,
        intent: 'LOGIN',
        client: input.client === 'web' ? 'WEB' : 'NATIVE',
        stateHash: sha256(state),
        bindingHash: sha256(binding),
        nonce,
        providerCodeVerifier,
        clientChallenge: codeChallenge,
        // Only a native client is handed it back (§4.2); the Web's targets are fixed paths.
        clientState: input.client === 'native' ? (clientState ?? null) : null,
        expiresAt: new Date(Date.now() + GOOGLE_FLOW_TTL_MS),
      },
    });
    const authorizationUrl = this.google.authorizationUrl({
      clientId,
      redirectUri: googleRedirectUri(),
      state,
      nonce,
      codeChallenge: s256(providerCodeVerifier),
    });
    return { authorizationUrl, binding };
  }

  /**
   * §4.2 steps 1–6: what Google sent back, checked in the design's order, and what the client is
   * answered. `bindings` are the values of every `orbit_oauth_flow` cookie the browser sent.
   */
  async callback(
    query: { state?: unknown; code?: unknown; error?: unknown },
    bindings: readonly string[],
  ): Promise<GoogleCallbackOutcome> {
    const flow = typeof query.state === 'string' && query.state !== ''
      ? await this.prisma.oAuthLoginFlow.findUnique({ where: { stateHash: sha256(query.state) } })
      : null;
    if (!flow) return { to: UNKNOWN_FLOW, error: 'GOOGLE_FLOW_EXPIRED' };
    const to: GoogleReturnTo = {
      client: flow.client === 'NATIVE' ? 'native' : 'web',
      intent: flow.intent === 'LINK' ? 'LINK' : 'LOGIN',
      clientState: flow.clientState,
    };
    // Step 1. An AUTHENTICATED flow's ticket is its client's until exchanged: a callback replayed
    // after it (the back button, or someone holding the address) is refused and leaves it alone.
    if (flow.status !== 'PENDING') return { to, error: 'GOOGLE_FLOW_EXPIRED' };
    // From here the state has been presented, and this is its only presentation: every refusal
    // below ends the flow, so the same state cannot be tried again with another cookie or code.
    const refuse = async (error: GoogleCallbackError): Promise<GoogleCallbackOutcome> => {
      await this.burn(flow.id);
      return { to, error };
    };
    if (flow.expiresAt.getTime() <= Date.now()) return refuse('GOOGLE_FLOW_EXPIRED');
    // Step 2: the browser that started the flow is the one that finishes it.
    if (!bindings.some((binding) => sameDigest(sha256(binding), flow.bindingHash))) return refuse('GOOGLE_FLOW_EXPIRED');
    // Step 3.
    if (query.error !== undefined) return refuse('GOOGLE_CANCELLED');
    const google = await this.signIn.googleClient().catch(() => {
      // The saved secret does not decrypt — PROVIDER_SECRET_KEY changed since it was saved (§7.1).
      this.log.error('the saved Google client secret cannot be decrypted; an administrator must enter it again');
      return undefined;
    });
    if (google === null) return refuse('GOOGLE_NOT_CONFIGURED');
    if (google === undefined) return refuse('GOOGLE_EXCHANGE_FAILED');
    if (typeof query.code !== 'string' || query.code === '') return refuse('GOOGLE_EXCHANGE_FAILED');
    // Step 4.
    const claims = await this.google.exchangeCode({
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      redirectUri: googleRedirectUri(),
      code: query.code,
      codeVerifier: flow.providerCodeVerifier,
    });
    if (!claims) return refuse('GOOGLE_EXCHANGE_FAILED');
    // Step 5.
    const verdict = verifyGoogleIdTokenClaims(claims, { clientId: google.clientId, nonce: flow.nonce, now: Date.now() });
    if (!verdict.ok) {
      this.log.warn(`refused Google's ID token: its ${verdict.claim} claim did not pass`);
      return refuse(verdict.code);
    }
    // Step 6.
    const ticket = generateToken(32);
    if (!(await this.authenticate(flow.id, verdict.identity, sha256(ticket)))) {
      // Another callback with this state finished first, or the flow was swept meanwhile.
      return { to, error: 'GOOGLE_FLOW_EXPIRED' };
    }
    return { to, ticket };
  }

  /**
   * §4.3: the ticket and the verifier for an Orbit session, the same answer POST /auth/login gives.
   * The ticket is taken out of the table before anything about it is checked, so it is spent by this
   * presentation whatever follows; of two presentations at once only one finds it.
   *
   * Of §5.2 this answers the first case — the Google account is already linked to an Orbit account,
   * which is signed in — and refuses every other with GOOGLE_ACCOUNT_NOT_FOUND for now.
   */
  async exchange(input: { ticket: string; codeVerifier: string; visitor: string }) {
    if (!(await this.signIn.methods()).google) {
      throw new ForbiddenException({ code: 'GOOGLE_NOT_CONFIGURED', message: 'Google sign-in is not enabled on this server' });
    }
    this.exchangeLimiter.take(input.visitor);
    const flow = await this.redeem(sha256(input.ticket));
    if (!flow
      || flow.ticketExpiresAt === null || flow.ticketExpiresAt.getTime() <= Date.now()
      || !CODE_VERIFIER.test(input.codeVerifier) || !sameDigest(s256(input.codeVerifier), flow.clientChallenge)
      || flow.intent !== 'LOGIN') {
      throw mismatch();
    }
    const identity = identityOf(flow.claims);
    if (!identity) throw mismatch();
    const user = await this.signInLinked(identity);
    if (!user) {
      throw new ForbiddenException({
        code: 'GOOGLE_ACCOUNT_NOT_FOUND',
        message: 'No Orbit account signs in with this Google account — ask an administrator to create one for your email address',
      });
    }
    return this.auth.completeLogin(user);
  }

  /** The rows past their end, swept on every start (§7.4). */
  private async sweep(): Promise<void> {
    await this.prisma.oAuthLoginFlow.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }

  /** End a flow a callback refused, if it is still PENDING. */
  private async burn(id: string): Promise<void> {
    await this.prisma.oAuthLoginFlow.deleteMany({ where: { id, status: 'PENDING' } });
  }

  /**
   * Record the verified identity and the ticket's hash on a flow still PENDING (§4.2 step 6). The
   * row's end moves to the ticket's, so the sweep keeps it exactly as long as the ticket can be
   * exchanged. False when the flow was no longer PENDING.
   */
  private async authenticate(id: string, identity: VerifiedGoogleIdentity, ticketHash: string): Promise<boolean> {
    const ticketExpiresAt = new Date(Date.now() + GOOGLE_TICKET_TTL_MS);
    const { count } = await this.prisma.oAuthLoginFlow.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'AUTHENTICATED', claims: { ...identity }, ticketHash, ticketExpiresAt, expiresAt: ticketExpiresAt },
    });
    return count === 1;
  }

  /** §4.3 step 1: one statement takes the flow that holds the ticket out of the table, and answers it. */
  private async redeem(ticketHash: string): Promise<RedeemedFlow | null> {
    const rows = await this.prisma.$queryRaw<RedeemedFlow[]>`
      DELETE FROM "oauth_login_flow" WHERE "ticket_hash" = ${ticketHash} AND "status" = 'AUTHENTICATED'
      RETURNING "intent", "client_challenge" AS "clientChallenge", "ticket_expires_at" AS "ticketExpiresAt", "claims"`;
    return rows[0] ?? null;
  }

  /**
   * §5.2 case 1: the Orbit account this Google account is linked to, its identity brought up to date
   * with what Google said this time — email, Workspace domain and when. Null when it is linked to none.
   */
  private async signInLinked(identity: VerifiedGoogleIdentity): Promise<User | null> {
    const linked = await this.prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: GOOGLE, subject: identity.sub } },
      include: { user: true },
    });
    if (!linked) return null;
    await this.prisma.userIdentity.update({
      where: { id: linked.id },
      data: { email: identity.email, hostedDomain: identity.hd, lastSignInAt: new Date() },
    });
    return linked.user;
  }
}
