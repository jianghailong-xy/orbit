import { Logger, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

/**
 * The runner link's connection tokens (docs/runner-link-design.md §5.4, §6.2; migration 0443).
 *
 * A runner trades its long-lived runner token for one of these over HTTPS and presents it to its
 * cell's link gateway, which checks it with the public key alone: the gateway never holds the
 * signing key and asks no database. The token is a compact JWS (RFC 7515) signed EdDSA over
 * Ed25519 (RFC 8037), so a verifier needs nothing beyond its language's own Ed25519. What a
 * verifier does is `verifyRunnerLinkToken` below, then one more check: the token's `credential` is
 * not among the revoked ones (`GET /api/runner/link-token/revocations`).
 *
 * The link is switched on by three settings, all of them or none:
 *
 *   RUNNER_LINK_SIGNING_KEY    base64 of an Ed25519 private key in PEM (PKCS#8)
 *   RUNNER_LINK_URL            the ws:// or wss:// address of the cell's gateway
 *   RUNNER_LINK_GATEWAY_TOKEN  the secret the gateway presents to read the revocations
 *
 * None set, the link is off and both of its routes answer 404 RUNNER_LINK_NOT_CONFIGURED, which is
 * what a server older than them answers too. Some set, or one unreadable, it is off as well, and
 * each problem is logged once at boot: a mistake in the link's configuration never stops the server
 * the HTTP protocol runs on.
 */

/** The audience every connection token names, and no other token this server signs. */
export const RUNNER_LINK_AUDIENCE = 'orbit-runner-link';

/** "About an hour" (design §5.4): the backstop for a revocation the gateway has not yet heard of. */
export const RUNNER_LINK_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * How far back the revocation list reaches: a token's lifetime, and ten minutes for a token minted
 * the moment its credential changed and for the clocks of the machines involved. An older
 * revocation can refuse nothing — every token minted with that credential has expired — so the
 * list leaves it out and the reaper purges it.
 */
export const RUNNER_LINK_REVOCATION_WINDOW_MS = (RUNNER_LINK_TOKEN_TTL_SECONDS + 10 * 60) * 1000;

/** The one cell there is (tenant_cell's CHECK in migration 0443). */
export const RUNNER_LINK_CELL = 'cell-1';

export const RUNNER_LINK_NOT_CONFIGURED = 'RUNNER_LINK_NOT_CONFIGURED';

/** A gateway's secret shorter than this is refused: it guards a route the internet can reach. */
const GATEWAY_TOKEN_MIN_LENGTH = 32;

export interface RunnerLinkConfig {
  signingKey: KeyObject;
  publicKey: KeyObject;
  /** The JWS header's `kid`: the public key's RFC 7638 thumbprint, so a gateway can hold two keys. */
  keyId: string;
  /** Where cell-1's gateway listens — the address of the only cell. */
  linkUrl: string;
  gatewayToken: string;
}

/** The link as this process runs it: its configuration, or null while it is off, and why. */
export interface RunnerLinkState {
  readonly config: RunnerLinkConfig | null;
  readonly problems: readonly string[];
}

/** The DI token of the process's one link state. */
export const RUNNER_LINK = Symbol('RUNNER_LINK');

/** What a connection token says. Ids are the UUIDs the control plane keys by. */
export interface RunnerLinkClaims {
  aud: string;
  jti: string;
  runnerId: string;
  /** The tenant: the account that owns the runner. */
  ownerId: string;
  cellId: string;
  linkUrl: string;
  /** The process identity the runner asked for the token under: its heartbeat `leaseOwner`. */
  leaseOwner: string;
  /** `runnerLinkCredential` of the runner credential the token was minted with. */
  credential: string;
  iat: number;
  exp: number;
}

/** The three settings as the environment spells them, read once at boot. */
export function readRunnerLink(settings: {
  signingKey?: string;
  linkUrl?: string;
  gatewayToken?: string;
}): RunnerLinkState {
  const signingKey = settings.signingKey?.trim() ?? '';
  const linkUrl = settings.linkUrl?.trim() ?? '';
  const gatewayToken = settings.gatewayToken?.trim() ?? '';
  if (!signingKey && !linkUrl && !gatewayToken) return { config: null, problems: [] };

  const problems: string[] = [];
  let key: KeyObject | null = null;
  if (!signingKey) {
    problems.push('RUNNER_LINK_SIGNING_KEY is not set');
  } else {
    try {
      key = createPrivateKey(Buffer.from(signingKey, 'base64').toString('utf8'));
    } catch {
      key = null;
    }
    if (key?.asymmetricKeyType !== 'ed25519') {
      key = null;
      problems.push(
        'RUNNER_LINK_SIGNING_KEY is not base64 of an Ed25519 private key in PEM '
          + '(generate: openssl genpkey -algorithm ed25519 | base64 -w0)',
      );
    }
  }
  if (!linkUrl) {
    problems.push('RUNNER_LINK_URL is not set');
  } else if (!isLinkAddress(linkUrl)) {
    problems.push(`RUNNER_LINK_URL=${JSON.stringify(linkUrl)} is not a ws:// or wss:// address`);
  }
  if (!gatewayToken) {
    problems.push('RUNNER_LINK_GATEWAY_TOKEN is not set');
  } else if (gatewayToken.length < GATEWAY_TOKEN_MIN_LENGTH) {
    problems.push(
      `RUNNER_LINK_GATEWAY_TOKEN is shorter than ${GATEWAY_TOKEN_MIN_LENGTH} characters (generate: openssl rand -base64 32)`,
    );
  }
  if (problems.length > 0 || !key) {
    return { config: null, problems: problems.map((problem) => `${problem}: the runner link is off`) };
  }
  const publicKey = createPublicKey(key);
  return {
    config: { signingKey: key, publicKey, keyId: thumbprint(publicKey), linkUrl, gatewayToken },
    problems: [],
  };
}

/** The process's link state: read from configuration once, and each problem logged once. */
export function runnerLinkFrom(
  config: Pick<ConfigService, 'get'>,
  log: Pick<Logger, 'error'> = new Logger('RunnerLink'),
): RunnerLinkState {
  const state = readRunnerLink({
    signingKey: config.get<string>('RUNNER_LINK_SIGNING_KEY'),
    linkUrl: config.get<string>('RUNNER_LINK_URL'),
    gatewayToken: config.get<string>('RUNNER_LINK_GATEWAY_TOKEN'),
  });
  for (const problem of state.problems) log.error(problem);
  return state;
}

/** What both link routes answer while the link is off: the 404 of a server without them. */
export function runnerLinkNotConfigured(): NotFoundException {
  return new NotFoundException({
    code: RUNNER_LINK_NOT_CONFIGURED,
    message: 'The runner link is not configured on this Orbit server; runners keep working over HTTP.',
  });
}

/**
 * The fingerprint of a runner credential, from the hash the `runner` row keeps of it. Migration
 * 0443's trigger computes the same value in SQL when it revokes one; the two must stay identical.
 */
export function runnerLinkCredential(tokenHash: string): string {
  return createHash('sha256').update(`orbit-runner-link:${tokenHash}`, 'utf8').digest('hex').slice(0, 32);
}

/** Mint one connection token, valid for RUNNER_LINK_TOKEN_TTL_SECONDS from `now`. */
export function signRunnerLinkToken(
  config: RunnerLinkConfig,
  subject: Pick<RunnerLinkClaims, 'runnerId' | 'ownerId' | 'cellId' | 'leaseOwner' | 'credential'>,
  now: Date,
): { token: string; claims: RunnerLinkClaims } {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: RunnerLinkClaims = {
    aud: RUNNER_LINK_AUDIENCE,
    jti: randomUUID(),
    runnerId: subject.runnerId,
    ownerId: subject.ownerId,
    cellId: subject.cellId,
    linkUrl: config.linkUrl,
    leaseOwner: subject.leaseOwner,
    credential: subject.credential,
    iat,
    exp: iat + RUNNER_LINK_TOKEN_TTL_SECONDS,
  };
  const input = `${segment({ alg: 'EdDSA', typ: 'JWT', kid: config.keyId })}.${segment(claims)}`;
  return { token: `${input}.${sign(null, Buffer.from(input), config.signingKey).toString('base64url')}`, claims };
}

export type RunnerLinkTokenRefusal = 'MALFORMED' | 'SIGNATURE' | 'AUDIENCE' | 'EXPIRED';

export class RunnerLinkTokenRefused extends Error {
  constructor(readonly reason: RunnerLinkTokenRefusal) {
    super(`runner link token refused: ${reason}`);
  }
}

/**
 * The link tokens whose signature this process has checked, by the key that checked them. A token is presented on every
 * call of its connection, about an hour of calls, and its Ed25519 check took a heartbeat 0.16 ms of the API server's
 * main thread (task O1). What the check decides is a function of the token's bytes and the key alone, so a token that
 * passed it stays passed; its expiry is still read against the clock on every call. Only tokens that passed every
 * check are kept, at most `limit` of them: when full, the expired go first, then the oldest.
 */
export class CheckedRunnerLinkTokens {
  private readonly byKey = new WeakMap<KeyObject, Map<string, Readonly<RunnerLinkClaims>>>();

  constructor(private readonly limit: number) {}

  get(token: string, publicKey: KeyObject): Readonly<RunnerLinkClaims> | undefined {
    return this.byKey.get(publicKey)?.get(token);
  }

  remember(token: string, publicKey: KeyObject, claims: RunnerLinkClaims, now: Date): void {
    let tokens = this.byKey.get(publicKey);
    if (!tokens) {
      tokens = new Map();
      this.byKey.set(publicKey, tokens);
    }
    if (tokens.size >= this.limit) {
      for (const [held, heldClaims] of tokens) if (now.getTime() >= heldClaims.exp * 1000) tokens.delete(held);
      for (const held of tokens.keys()) {
        if (tokens.size < this.limit) break;
        tokens.delete(held);
      }
    }
    tokens.set(token, Object.freeze(claims));
  }
}

/** A cell's connections and their renewals, with room: about 17,000 live tokens for 15,000 runners (design §9). */
const checkedRunnerLinkTokens = new CheckedRunnerLinkTokens(20_000);

/**
 * What the gateway does with a token before it upgrades the connection, in TypeScript: the specs
 * hold the signer to it, and the gateway's own verifier accepts and refuses exactly the same tokens.
 * Only `EdDSA` is taken, whatever else a header names. Revocation is the separate check above. A
 * token this process has checked before is not checked again (CheckedRunnerLinkTokens), only its expiry.
 */
export function verifyRunnerLinkToken(token: string, publicKey: KeyObject, now: Date): RunnerLinkClaims {
  const checked = checkedRunnerLinkTokens.get(token, publicKey);
  if (checked) {
    if (now.getTime() >= checked.exp * 1000) throw new RunnerLinkTokenRefused('EXPIRED');
    return checked;
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new RunnerLinkTokenRefused('MALFORMED');
  const [header, payload, signature] = parts;
  let head: { alg?: unknown };
  let claims: RunnerLinkClaims;
  try {
    head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new RunnerLinkTokenRefused('MALFORMED');
  }
  if (head?.alg !== 'EdDSA') throw new RunnerLinkTokenRefused('MALFORMED');
  let signed: boolean;
  try {
    signed = verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    signed = false;
  }
  if (!signed) throw new RunnerLinkTokenRefused('SIGNATURE');
  if (claims?.aud !== RUNNER_LINK_AUDIENCE) throw new RunnerLinkTokenRefused('AUDIENCE');
  if (typeof claims.exp !== 'number' || now.getTime() >= claims.exp * 1000) {
    throw new RunnerLinkTokenRefused('EXPIRED');
  }
  checkedRunnerLinkTokens.remember(token, publicKey, claims, now);
  return claims;
}

/** Whether an Authorization header carries the gateway's secret. Compared in constant time. */
export function isRunnerLinkGateway(config: RunnerLinkConfig, authorization: string | undefined): boolean {
  const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  return timingSafeEqual(digest(presented), digest(config.gatewayToken));
}

function isLinkAddress(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'wss:' || protocol === 'ws:';
  } catch {
    return false;
  }
}

/** RFC 7638: the SHA-256 of the key's required JWK members, in lexicographic order. */
function thumbprint(publicKey: KeyObject): string {
  const { crv, kty, x } = publicKey.export({ format: 'jwk' });
  return createHash('sha256').update(JSON.stringify({ crv, kty, x })).digest('base64url');
}

function segment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Equal lengths for timingSafeEqual, whatever was presented. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
