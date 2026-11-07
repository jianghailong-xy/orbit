import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type FeishuApp } from '@prisma/client';
import {
  FEISHU_APP_TAKEN,
  FEISHU_APP_TAKEN_MESSAGE,
  FEISHU_NOT_ALLOWED,
  FEISHU_NOT_ALLOWED_MESSAGE,
  FEISHU_OPEN_PLATFORM_ORIGINS,
  type FeishuAdminSettings,
  type FeishuAppChange,
  type FeishuAppConnect,
  type FeishuAppSettings,
  type FeishuCredentialRefusal,
  type FeishuIntegration,
  type FeishuMessageDetail,
  type FeishuPlatform,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../providers/provider-crypto';
import { conflictingUniqueKey } from '../tasks/task-supersession';
import { checkCredentials, type CredentialCheck } from './feishu-open-platform';

/** pg_advisory_xact_lock namespace for the per-account save serializer (`save`): 4,000,000 plus the migration's number. */
const SAVE_LOCK_NAMESPACE = 4000489;

/** The unique index another account's App ID collides on (migration 0489). */
const APP_ID_KEY = 'feishu_app_app_id_key';

/**
 * Whether a saved secret still decrypts with the `PROVIDER_SECRET_KEY` in force (§4.1). Rotating that key makes it
 * unreadable, and the row alone cannot say so: try it, and answer rather than throw. Nothing about the attempt is kept.
 */
function secretIsUnreadable(stored: string): boolean {
  if (stored === '') return false;
  try {
    decryptSecret(stored);
    return false;
  } catch {
    return true;
  }
}

/** The app as every route answers it: never the secret, in either form. */
function settingsOf(row: FeishuApp): FeishuAppSettings {
  return {
    platform: row.platform as FeishuPlatform,
    appId: row.appId,
    hasSecret: row.appSecretEnc !== '',
    secretUnreadable: secretIsUnreadable(row.appSecretEnc),
    enabled: row.enabled,
    messageDetail: row.messageDetail as FeishuMessageDetail,
    approvalsInFeishu: row.approvalsInFeishu,
    defaultWorkspaceId: row.defaultWorkspaceId,
    ownerOpenId: row.ownerOpenId,
    ownerName: row.ownerName,
    botName: row.botName,
    lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The 400 a save answers when Feishu would not trade the credentials, or could not be asked. Nothing was written. */
function refusal(platform: FeishuPlatform, check: Exclude<CredentialCheck, { ok: true }>): FeishuCredentialRefusal {
  const host = new URL(FEISHU_OPEN_PLATFORM_ORIGINS[platform]).host;
  if (check.code === 'FEISHU_CREDENTIALS_REJECTED') {
    return {
      code: check.code,
      message: `Feishu did not accept this App ID and App Secret: ${check.feishuMsg || 'no reason given'} (code ${check.feishuCode}). Nothing was saved.`,
      feishuCode: check.feishuCode,
      feishuMsg: check.feishuMsg,
    };
  }
  return {
    code: check.code,
    message: `Orbit could not check these credentials with ${host} (${check.reason}). Nothing was saved; try again.`,
    feishuCode: null,
    feishuMsg: null,
  };
}

/**
 * Each account's own Feishu (Lark) self-built app (docs/feishu-bot-design.md §4.1, §10; `feishu_app`, migration
 * 0489), and the administrators' switch for them (`feishu_deployment_setting`).
 *
 * An app is saved only after Feishu traded its credentials for a tenant_access_token, and its App Secret only
 * encrypted (providers/provider-crypto.ts): nothing here answers or logs the secret, what is stored for it, or the
 * token. An App ID is connected to one account of this server at most, because an app's long connection has one
 * consumer (§3.2): a second account saving it is refused 409.
 */
@Injectable()
export class FeishuAppService {
  private readonly logger = new Logger(FeishuAppService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Whether accounts may connect Feishu bots. No row is on: the switch's default (§4.1). */
  async allowed(): Promise<boolean> {
    const row = await this.prisma.feishuDeploymentSetting.findUnique({ where: { id: 1 }, select: { allowed: true } });
    return row?.allowed ?? true;
  }

  /** `GET /integrations/feishu`: the switch, and the account's app, null while it has none. */
  async integration(ownerId: string): Promise<FeishuIntegration> {
    const [allowed, app] = await Promise.all([this.allowed(), this.prisma.feishuApp.findUnique({ where: { ownerId } })]);
    return { allowed, app: app ? settingsOf(app) : null };
  }

  /**
   * `PUT /integrations/feishu`: connect an app, or replace the one connected (§4.1). Refused 403 while the
   * administrators' switch is off. The secret is encrypted first, so a server that cannot store it asks Feishu
   * nothing; then Feishu is asked for a tenant_access_token with these credentials, and anything but one is a 400
   * carrying Feishu's code and message, with nothing written. Only then is the app saved (`save`), and an App ID
   * another account holds is refused 409.
   */
  async connect(ownerId: string, input: FeishuAppConnect): Promise<FeishuIntegration> {
    if (!(await this.allowed())) throw new ForbiddenException({ code: FEISHU_NOT_ALLOWED, message: FEISHU_NOT_ALLOWED_MESSAGE });
    const platform = input.platform;
    const appId = input.appId.trim();
    const appSecret = input.appSecret.trim();
    if (appId === '' || appSecret === '') throw new BadRequestException('Enter both the App ID and the App Secret.');
    const appSecretEnc = encryptSecret(appSecret);
    const check = await checkCredentials({ platform, appId, appSecret });
    if (!check.ok) throw new BadRequestException(refusal(platform, check));
    try {
      await this.save(ownerId, { platform, appId, appSecretEnc });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === 'P2002'
        && conflictingUniqueKey(error).includes(APP_ID_KEY)
      ) {
        throw new ConflictException({ code: FEISHU_APP_TAKEN, message: FEISHU_APP_TAKEN_MESSAGE });
      }
      throw error;
    }
    this.logger.log(`account ${ownerId} connected Feishu app ${appId} on ${platform}`);
    return this.integration(ownerId);
  }

  /**
   * Write a checked app as the account's, under a per-account advisory lock, so two saves of one account run one
   * after the other and the second decides against what the first committed. The same app on the same platform
   * keeps its row and takes the new secret: the owner's identity and the status stand, and the last failure is
   * cleared. Another app replaces the row: open_ids are per app (§4.1), so the owner's identity and the status go
   * with the old one, and so will whatever later hangs off it; the account's own choices — the switch, the detail,
   * approvals in Feishu, the default workspace — carry over. An App ID another account holds fails the insert on
   * its unique key, and the old row stays.
   */
  private async save(ownerId: string, app: { platform: FeishuPlatform; appId: string; appSecretEnc: string }): Promise<void> {
    const lockKey = parseInt(createHash('sha256').update(ownerId).digest('hex').slice(0, 8), 16) & 0x7fffffff;
    await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SAVE_LOCK_NAMESPACE}, ${lockKey})`;
      const current = await tx.feishuApp.findUnique({ where: { ownerId } });
      if (current && current.platform === app.platform && current.appId === app.appId) {
        await tx.feishuApp.update({ where: { id: current.id }, data: { appSecretEnc: app.appSecretEnc, lastError: null } });
        return;
      }
      if (current) await tx.feishuApp.delete({ where: { id: current.id } });
      const kept = current
        ? {
            enabled: current.enabled,
            messageDetail: current.messageDetail,
            approvalsInFeishu: current.approvalsInFeishu,
            defaultWorkspaceId: current.defaultWorkspaceId,
          }
        : {};
      await tx.feishuApp.create({ data: { ownerId, ...app, ...kept } });
    }, loggedRetry(this.logger, 'feishuApp.save'));
  }

  /** `PATCH /integrations/feishu`: the app's own switch. 404 while the account has no app; nothing asked, nothing written. */
  async change(ownerId: string, change: FeishuAppChange): Promise<FeishuIntegration> {
    if (change.enabled !== undefined) {
      const { count } = await this.prisma.feishuApp.updateMany({ where: { ownerId }, data: { enabled: change.enabled } });
      if (count === 0) throw new NotFoundException('No Feishu app is connected to this account.');
      return this.integration(ownerId);
    }
    const integration = await this.integration(ownerId);
    if (!integration.app) throw new NotFoundException('No Feishu app is connected to this account.');
    return integration;
  }

  /** `DELETE /integrations/feishu`: remove the account's app (§4.1). Removing none answers the same. */
  async remove(ownerId: string): Promise<FeishuIntegration> {
    const { count } = await this.prisma.feishuApp.deleteMany({ where: { ownerId } });
    if (count > 0) this.logger.log(`account ${ownerId} removed its Feishu app`);
    return this.integration(ownerId);
  }

  /** `GET /admin/integrations/feishu`: the switch, and how many apps accounts connected, how many of them on. */
  async adminSettings(): Promise<FeishuAdminSettings> {
    const [allowed, connectedApps, enabledApps] = await Promise.all([
      this.allowed(),
      this.prisma.feishuApp.count(),
      this.prisma.feishuApp.count({ where: { enabled: true } }),
    ]);
    return { allowed, connectedApps, enabledApps };
  }

  /** `PUT /admin/integrations/feishu`: switch it, as `adminId`. Asking for the state it is in writes nothing. */
  async setAllowed(adminId: string, allowed: boolean): Promise<FeishuAdminSettings> {
    if ((await this.allowed()) !== allowed) {
      await this.prisma.feishuDeploymentSetting.upsert({
        where: { id: 1 },
        create: { id: 1, allowed, updatedById: adminId },
        update: { allowed, updatedById: adminId, updatedAt: new Date() },
      });
      this.logger.log(`Feishu bots ${allowed ? 'allowed' : 'turned off'} by administrator ${adminId}`);
    }
    return this.adminSettings();
  }

  /** `DELETE /admin/users/:id/feishu`: remove an account's app (§4.1). 404 for no such account; none to remove is answered so. */
  async removeByAdmin(adminId: string, userId: string): Promise<{ removed: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('user not found');
    const { count } = await this.prisma.feishuApp.deleteMany({ where: { ownerId: userId } });
    if (count > 0) this.logger.log(`administrator ${adminId} removed the Feishu app of account ${userId}`);
    return { removed: count > 0 };
  }
}
