import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { generateToken, sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { SharedRateLimiter } from '../shared/public-surface.guard';
import { USER_NAME_MAX_CHARS } from '../users/dto';
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
 * Why a Google account that signed in has no Orbit account to sign in as (§5.2), each answered 403
 * with its code (§4.3 step 3) and a sentence the person can act on.
 */
const RESOLUTION_REFUSALS = {
  SETUP_REQUIRED: 'This Orbit server has no accounts yet — create its first administrator at /setup, with an email and a password',
  GOOGLE_EMAIL_AMBIGUOUS: 'More than one Orbit account uses this email address, differing only in letter case — ask an administrator to correct them',
  GOOGLE_ACCOUNT_MISMATCH: 'The Orbit account with this email address is connected to a different Google account — sign in with that one, or with your password',
  GOOGLE_EMAIL_NOT_AUTHORITATIVE: "Google can't vouch that this email address is still yours — sign in with your password, then connect Google on your profile page",
  GOOGLE_ACCOUNT_NOT_FOUND: 'No Orbit account signs in with this Google account — ask an administrator to create one for your email address',
} as const;

const refused = (code: keyof typeof RESOLUTION_REFUSALS) => new ForbiddenException({ code, message: RESOLUTION_REFUSALS[code] });

/** The addresses Google itself hosts (§5.2). */
const GMAIL_DOMAINS: readonly string[] = ['gmail.com', 'googlemail.com'];

/**
 * Whether Google is authoritative for the email it gave (§5.2), which is what lets a Google sign-in
 * link itself to the Orbit account that has that email: the email is verified, and it is a Gmail
 * address or the Google account is a Workspace one (`hd`). A personal Google account registered with
 * any other address had it verified once, when it was registered; Google does not say the person
 * still holds it.
 */
export function googleIsAuthoritative(identity: { email: string; emailVerified: boolean; hd: string | null }): boolean {
  if (identity.emailVerified !== true) return false;
  if (identity.hd !== null && identity.hd !== '') return true;
  const at = identity.email.lastIndexOf('@');
  return at > 0 && GMAIL_DOMAINS.includes(identity.email.slice(at + 1).toLowerCase());
}

/**
 * The Activity row of a Google account linked to an Orbit account (§5.2, §5.3), written with the
 * link: the payload names the provider, the Google email, and how — AUTO, by the authoritative email
 * of an account that existed, or SIGNUP, together with the account opened for it.
 */
export const IDENTITY_LINKED_ACTIVITY = 'identity.linked';

/**
 * The name of an account a Google sign-in opens (§5.2 case 5): Google's `name`, cut to the longest
 * name a person may give themselves, or else the email's local part.
 */
function signupName(identity: VerifiedGoogleIdentity): string {
  const name = Array.from(identity.name?.trim() ?? '').slice(0, USER_NAME_MAX_CHARS).join('').trim();
  return name || identity.email.split('@')[0];
}

/** An Orbit account a Google sign-in signs in as: what AuthService.completeLogin issues tokens for. */
interface SignedInUser {
  id: string;
  email: string;
  name: string;
}

/** An account whose email is the Google one in some letter case, and whether a Google account is linked to it. */
interface EmailMatch extends SignedInUser {
  linked: boolean;
}

/**
 * Signing in with Google (docs/google-sign-in-design.md §4): the start that sends a browser to Google,
 * the callback that verifies what Google sent back and hands the client a one-time ticket, and the
 * exchange of that ticket for a session on the Orbit account §5.2 finds, links or opens for it. The
 * callback settles nothing: the session is issued only to whoever presents the ticket together with
 * the verifier of the challenge the start was given.
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
   * presentation whatever follows; of two presentations at once only one finds it. Which Orbit
   * account it signs in as is §5.2's to say (`resolve`).
   */
  async exchange(input: { ticket: string; codeVerifier: string; visitor: string }) {
    const methods = await this.signIn.methods();
    if (!methods.google) {
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
    const user = await this.resolve(identity, methods.googleSignup).catch((error: unknown) => {
      // Two first sign-ins of one Google account at once (§5.2): the unique keys — user_identity's
      // (provider, subject) and (user_id, provider), and the user's email — let one of them link or
      // open the account and fail the other's write, which then reads once more and finds the
      // account the first one linked (case 1).
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      return this.resolve(identity, methods.googleSignup);
    });
    return this.auth.completeLogin(user);
  }

  /**
   * §5.2, in its order: the Orbit account a verified Google identity signs in as — the one it is
   * linked to, the one its authoritative email links it to now, or the one opened for it when
   * `signup` (the OPEN policy) — or the refusal that says why there is none. The identity is always
   * known by Google's `sub`; the email only finds the account a first sign-in links to, and an
   * account opened for a Google account is linked to it by `sub` whatever its email.
   */
  private async resolve(identity: VerifiedGoogleIdentity, signup: boolean): Promise<SignedInUser> {
    // Case 1: the Google account is linked.
    const linked = await this.signInLinked(identity);
    if (linked) return linked;
    // Case 2: no account exists yet, and the first is the administrator /setup makes.
    if ((await this.prisma.user.count()) === 0) throw refused('SETUP_REQUIRED');
    // Cases 3 and 4: the accounts with this email.
    const matches = await this.usersByEmail(identity.email);
    if (matches.length > 1) throw refused('GOOGLE_EMAIL_AMBIGUOUS');
    if (matches.length === 1) {
      const [match] = matches;
      // ACCOUNT_DISABLED, the first answer for a matched account, is X1's (§5.5): it goes here,
      // before any other.
      if (match.linked) throw refused('GOOGLE_ACCOUNT_MISMATCH');
      if (!googleIsAuthoritative(identity)) throw refused('GOOGLE_EMAIL_NOT_AUTHORITATIVE');
      return this.link(identity, match);
    }
    // Cases 5 and 6: no account has this email.
    if (!signup) throw refused('GOOGLE_ACCOUNT_NOT_FOUND');
    return this.link(identity, null);
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
    // ACCOUNT_DISABLED, case 1's other answer, is X1's (§5.5): a disabled account is refused here,
    // before its identity is touched.
    await this.prisma.userIdentity.update({
      where: { id: linked.id },
      data: { email: identity.email, hostedDomain: identity.hd, lastSignInAt: new Date() },
    });
    return linked.user;
  }

  /**
   * §5.2 cases 3 and 4: the accounts whose email is this one in any letter case, and whether each
   * has a Google account linked. Matched on lower(email) because the email's unique index is on the
   * address as written (migration 0392); two rows are enough to know there is more than one.
   */
  private usersByEmail(email: string): Promise<EmailMatch[]> {
    return this.prisma.$queryRaw<EmailMatch[]>`
      SELECT u."id", u."email", u."name",
        EXISTS (SELECT 1 FROM "user_identity" i WHERE i."user_id" = u."id" AND i."provider" = ${GOOGLE}) AS "linked"
      FROM "user" u WHERE lower(u."email") = lower(${email})
      LIMIT 2`;
  }

  /**
   * §5.2 cases 3 and 5: link the Google account to `user`, the account its authoritative email found
   * (AUTO) — or, with none, to an account opened for it now (SIGNUP): a MEMBER with no password, which
   * signs in with Google only — and record the link in Activity, all in one transaction, so that
   * neither a link nor an opened account is ever left without the other or without its record. Of two
   * first sign-ins at once, the unique keys fail the second's write (`exchange`).
   */
  private link(identity: VerifiedGoogleIdentity, user: SignedInUser | null): Promise<SignedInUser> {
    return this.prisma.$transaction(async (tx) => {
      const account = user ?? await tx.user.create({
        data: { email: identity.email, name: signupName(identity), role: 'MEMBER', passwordHash: null },
      });
      await tx.userIdentity.create({
        data: {
          userId: account.id,
          provider: GOOGLE,
          subject: identity.sub,
          email: identity.email,
          hostedDomain: identity.hd,
          lastSignInAt: new Date(),
        },
      });
      await tx.activity.create({
        data: {
          actorId: account.id,
          type: IDENTITY_LINKED_ACTIVITY,
          payload: { provider: GOOGLE, email: identity.email, method: user ? 'AUTO' : 'SIGNUP' },
          credentialKind: 'LOGIN',
        },
      });
      return { id: account.id, email: account.email, name: account.name };
    });
  }
}
