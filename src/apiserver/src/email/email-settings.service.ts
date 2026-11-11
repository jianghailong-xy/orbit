import { Injectable } from '@nestjs/common';
import type { EmailSettings, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../providers/provider-crypto';
import { sendViaResend, type SendResult } from './resend.client';
import { escapeHtml } from './welcome-email.template';

/** The one row's id (`email_settings_one_row_chk`). */
const ROW = 1;

/** This deployment's PUBLIC_ORIGIN, as sign-in-providers.service.ts reads it. */
export function publicOrigin(): string {
  return (process.env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/, '');
}

/** What the card head says is missing while the channel is Off (docs/welcome-email-design.md §3.1). */
export type EmailMissing = 'SWITCH' | 'API_KEY' | 'FROM' | 'API_KEY_UNREADABLE';

/** `GET` and `PUT /admin/email`. Says whether a key is saved, never what it is. */
export interface EmailSettingsView {
  enabled: boolean;
  hasApiKey: boolean;
  /** A key is saved and the current PROVIDER_SECRET_KEY cannot decrypt it: sending is paused until it is pasted again. */
  apiKeyUnreadable: boolean;
  fromAddress: string;
  replyTo: string;
  /** What an empty Reply-To stands for: the earliest administrator's address, null with none. */
  replyToDefault: string | null;
  welcomeEnabled: boolean;
  /** Switched on, a key saved that decrypts, and a From address. */
  on: boolean;
  /** Why it is not on, in the order the card says it; empty when on. */
  missing: EmailMissing[];
  /** The last seven days of the outbox. */
  lastWeek: {
    sent: number;
    failed: number;
    failures: Array<{ email: string; at: string; error: string }>;
  };
}

export interface EmailSettingsChange {
  enabled: boolean;
  /** Left out, the saved key stays. */
  apiKey?: string;
  fromAddress: string;
  replyTo: string;
  welcomeEnabled: boolean;
}

/** What the worker sends with. */
export interface EmailChannel {
  apiKey: string;
  from: string;
  replyTo: string | null;
}

/**
 * POST /admin/email/test: what Resend answered. Resend's email id is a UUID, so it is answered as
 * `resendId`, a name the public-id interceptor never rewrites (an `id` would come back as base62).
 */
export type TestEmailResult =
  | { ok: true; to: string; resendId: string }
  | { ok: false; to: string; status: number | null; error: string };

type Reader = Pick<Prisma.TransactionClient, 'emailSettings'>;

export function readEmailSettings(db: Reader): Promise<EmailSettings | null> {
  return db.emailSettings.findUnique({ where: { id: ROW } });
}

/**
 * Whether a new account's welcome row is written PENDING rather than SKIPPED (§3.3): the switch, a saved
 * key, a From and the welcome toggle. A key that no longer decrypts still counts as saved: sending is
 * paused until it is pasted again, and the row waits rather than being skipped.
 */
export function welcomeQueued(row: EmailSettings | null): boolean {
  return row !== null && row.enabled && row.resendApiKeyEnc !== '' && row.fromAddress !== '' && row.welcomeEnabled;
}

function keyUnreadable(stored: string): boolean {
  if (stored === '') return false;
  try {
    decryptSecret(stored);
    return false;
  } catch {
    return true;
  }
}

export function missingOf(row: EmailSettings | null): EmailMissing[] {
  const missing: EmailMissing[] = [];
  if (!row?.enabled) missing.push('SWITCH');
  if (!row?.resendApiKeyEnc) missing.push('API_KEY');
  else if (keyUnreadable(row.resendApiKeyEnc)) missing.push('API_KEY_UNREADABLE');
  if (!row?.fromAddress) missing.push('FROM');
  return missing;
}

/**
 * Admin → Email (docs/welcome-email-design.md §3.1, decision D2): the Resend key, From, Reply-To and
 * the welcome toggle, in `email_settings` (migration 0516). Read on every request and on every worker
 * pass, so a save holds from the next one, without a restart.
 */
@Injectable()
export class EmailSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The earliest administrator's address: what an empty Reply-To stands for. */
  async defaultReplyTo(): Promise<string | null> {
    const admin = await this.prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { email: true } });
    return admin?.email ?? null;
  }

  /** The channel the worker sends through: null while it is not on (off, incomplete, or the key unreadable). */
  async channel(): Promise<EmailChannel | null> {
    const row = await readEmailSettings(this.prisma);
    if (missingOf(row).length > 0) return null;
    return {
      apiKey: decryptSecret(row!.resendApiKeyEnc),
      from: row!.fromAddress,
      replyTo: row!.replyTo || (await this.defaultReplyTo()),
    };
  }

  async view(now: Date = new Date()): Promise<EmailSettingsView> {
    const row = await readEmailSettings(this.prisma);
    const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const [sent, failures, replyToDefault] = await Promise.all([
      this.prisma.emailOutbox.count({ where: { status: 'SENT', sentAt: { gte: since } } }),
      this.prisma.emailOutbox.findMany({
        where: { status: 'FAILED', lastAttemptAt: { gte: since } },
        orderBy: { lastAttemptAt: 'desc' },
        select: { toAddress: true, lastAttemptAt: true, lastError: true },
      }),
      this.defaultReplyTo(),
    ]);
    const missing = missingOf(row);
    return {
      enabled: row?.enabled ?? false,
      hasApiKey: (row?.resendApiKeyEnc ?? '') !== '',
      apiKeyUnreadable: missing.includes('API_KEY_UNREADABLE'),
      fromAddress: row?.fromAddress ?? '',
      replyTo: row?.replyTo ?? '',
      replyToDefault,
      welcomeEnabled: row?.welcomeEnabled ?? true,
      on: missing.length === 0,
      missing,
      lastWeek: {
        sent,
        failed: failures.length,
        failures: failures.map((f) => ({ email: f.toAddress, at: f.lastAttemptAt!.toISOString(), error: f.lastError ?? '' })),
      },
    };
  }

  /** One upsert of the whole setting. A key given replaces the saved one; none given keeps it. */
  async update(adminId: string, change: EmailSettingsChange): Promise<EmailSettingsView> {
    const key = change.apiKey ? encryptSecret(change.apiKey) : undefined;
    const fields = {
      enabled: change.enabled,
      fromAddress: change.fromAddress,
      replyTo: change.replyTo,
      welcomeEnabled: change.welcomeEnabled,
      updatedById: adminId,
    };
    await this.prisma.emailSettings.upsert({
      where: { id: ROW },
      create: { id: ROW, ...fields, resendApiKeyEnc: key ?? '' },
      update: key === undefined ? fields : { ...fields, resendApiKeyEnc: key },
    });
    return this.view();
  }

  /**
   * Sends a test email to the administrator asking, with the saved setting (the switch aside, so it can
   * be tried before it is turned on), and answers what Resend said. Nothing is written.
   */
  async sendTest(adminEmail: string): Promise<TestEmailResult> {
    const row = await readEmailSettings(this.prisma);
    if (!row?.resendApiKeyEnc) return { ok: false, to: adminEmail, status: null, error: 'Save a Resend API key first.' };
    if (!row.fromAddress) return { ok: false, to: adminEmail, status: null, error: 'Save a From address first.' };
    let apiKey: string;
    try {
      apiKey = decryptSecret(row.resendApiKeyEnc);
    } catch {
      return { ok: false, to: adminEmail, status: null, error: "The saved API key can't be decrypted (PROVIDER_SECRET_KEY changed). Paste it again." };
    }
    const origin = publicOrigin();
    const result: SendResult = await sendViaResend(
      apiKey,
      {
        from: row.fromAddress,
        to: adminEmail,
        replyTo: row.replyTo || (await this.defaultReplyTo()),
        subject: 'Orbit test email',
        html: `<p>This is a test email from Orbit at ${escapeHtml(origin)}. Outgoing email works.</p>`,
        text: `This is a test email from Orbit at ${origin}. Outgoing email works.\n`,
      },
    );
    if (result.outcome === 'SENT') return { ok: true, to: adminEmail, resendId: result.id };
    // Resend's own message, without the status the answer carries beside it.
    const error = result.status === null ? result.error : result.error.replace(`${result.status} `, '');
    return { ok: false, to: adminEmail, status: result.status, error };
  }
}
