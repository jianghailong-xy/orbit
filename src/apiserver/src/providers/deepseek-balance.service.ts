import { createHmac, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ProviderBalance, ProviderBalanceRead } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  BALANCE_TIMEOUT_MS,
  DEEPSEEK_BALANCE_URL,
  balanceFailureOf,
  isDeepSeekAccountRow,
  networkFailure,
  parseDeepSeekBalance,
  UNREADABLE_BALANCE,
} from './deepseek-balance';
import { decryptSecret } from './provider-crypto';
import { COMPATIBILITY_GUARD_SLUGS } from './providers.service';

/** How long a read is served before the next one asks DeepSeek again. */
export const BALANCE_FRESH_MS = 90_000;
/** A refresh asks DeepSeek again at most this often for one key; sooner, it gets the last read. */
export const BALANCE_REFRESH_THROTTLE_MS = 10_000;

interface Entry {
  read: ProviderBalanceRead;
  /** When the read was asked for (ms), which is what both clocks above count from. */
  at: number;
}

/**
 * The DeepSeek account balance behind the caller's own DeepSeek keys (deepseek-balance.ts), read
 * on demand with the stored key, which never leaves this server.
 *
 * Reads are cached per KEY, not per provider: two providers holding one key — the DeepSeek preset
 * and DeepSeek Harness, typically — are one account, so they share one read and can never show two
 * different balances. The cache is keyed by an HMAC of the key under a secret drawn per process, so
 * what it is keyed by names a key only inside this process.
 */
@Injectable()
export class DeepSeekBalanceService {
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<Entry>>();
  private readonly fingerprintSecret = randomBytes(32);

  constructor(private readonly prisma: PrismaService) {}

  /** One of the owner's providers' balance — `refresh` asks DeepSeek again unless the last read is
   *  younger than the throttle — with the owner's other DeepSeek providers that hold the same key. */
  async balance(ownerId: string, id: string, refresh: boolean): Promise<ProviderBalance> {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId, slug: { notIn: COMPATIBILITY_GUARD_SLUGS } },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: { id: true, label: true, presetSlug: true, baseUrl: true, apiKeyEnc: true },
    });
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new NotFoundException('provider not found');
    if (!isDeepSeekAccountRow(row)) throw new BadRequestException('only a DeepSeek key has an account balance');
    if (!row.apiKeyEnc) throw new NotFoundException('provider has no API key');
    let key: string;
    try {
      key = decryptSecret(row.apiKeyEnc);
    } catch {
      // Stored under an earlier PROVIDER_SECRET_KEY: nothing can read it until it is saved again.
      throw new ConflictException("this provider's stored key can't be read — save the key again");
    }
    const fingerprint = this.fingerprint(key);
    const { read } = await this.read(fingerprint, key, refresh);
    const sharedWith = rows
      .filter((other) => other.id !== row.id && isDeepSeekAccountRow(other) && this.holds(other.apiKeyEnc, fingerprint))
      .map((other) => ({ id: other.id, label: other.label }));
    return { ...read, sharedWith };
  }

  private fingerprint(key: string): string {
    return createHmac('sha256', this.fingerprintSecret).update(key).digest('hex');
  }

  private holds(keyEnc: string, fingerprint: string): boolean {
    if (!keyEnc) return false;
    try {
      return this.fingerprint(decryptSecret(keyEnc)) === fingerprint;
    } catch {
      return false;
    }
  }

  /** This key's last read while it is fresh — for a refresh, while it is younger than the throttle —
   *  else a new one. Callers asking at once share the one request in flight. */
  private read(fingerprint: string, key: string, refresh: boolean): Promise<Entry> {
    const cached = this.cache.get(fingerprint);
    if (cached && Date.now() - cached.at < (refresh ? BALANCE_REFRESH_THROTTLE_MS : BALANCE_FRESH_MS)) {
      return Promise.resolve(cached);
    }
    const running = this.inFlight.get(fingerprint);
    if (running) return running;
    const at = Date.now();
    const run = this.ask(key, new Date(at).toISOString())
      .then((read) => {
        // A replaced key's read is never asked for again; drop whatever has gone stale.
        for (const [other, entry] of this.cache) if (Date.now() - entry.at >= BALANCE_FRESH_MS) this.cache.delete(other);
        const entry = { read, at };
        this.cache.set(fingerprint, entry);
        return entry;
      })
      .finally(() => this.inFlight.delete(fingerprint));
    this.inFlight.set(fingerprint, run);
    return run;
  }

  /** DeepSeek's answer, or why there is none. Never rejects. */
  private async ask(key: string, fetchedAt: string): Promise<ProviderBalanceRead> {
    let resp: Response;
    try {
      resp = await fetch(DEEPSEEK_BALANCE_URL, {
        // A redirect would carry the key somewhere else; it reads as an error instead.
        redirect: 'manual',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, ...networkFailure((e as Error).name === 'TimeoutError'), fetchedAt };
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return { ok: false, ...balanceFailureOf(resp.status), fetchedAt };
    }
    const parsed = parseDeepSeekBalance(await resp.json().catch(() => null));
    return parsed ? { ok: true, ...parsed, fetchedAt } : { ok: false, ...UNREADABLE_BALANCE, fetchedAt };
  }
}
