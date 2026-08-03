import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from './provider-crypto';

const log = new Logger('SubscriptionToken');

/** ModelProvider.authMode: what api_key_enc holds and what dispatch injects. */
export const AUTH_MODE_API_KEY = 'api_key';
export const AUTH_MODE_SUBSCRIPTION = 'subscription';

/**
 * The token for a user's *default* Claude account, decrypted for injection as
 * CLAUDE_CODE_OAUTH_TOKEN at dispatch.
 *
 * This is the fallback path: a session whose agent names no provider of its own runs on the
 * built-in claude runtime, and the default account is what that runs as. An agent that *does*
 * name a subscription row goes through resolveProviderExec's customRow branch instead, which
 * injects that specific account's token.
 *
 * Returns null for "no account configured" AND for a token that won't decrypt (e.g. the
 * encryption key was rotated). Both mean the same thing operationally: dispatch proceeds and
 * the runner falls back to its own local `claude auth login`. A dispatch must never fail
 * because of this — a broken stored credential should degrade to the pre-existing behavior,
 * not take the session down.
 */
export async function claudeOauthTokenFor(
  prisma: PrismaService,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  // Only the default is eligible here; a non-default account reaches a session by being named.
  // `enabled` is honoured so switching an account off stops it being dispatched without having
  // to delete it, matching how a disabled API-key provider behaves.
  const row = await prisma.modelProvider.findFirst({
    where: {
      ownerId: userId,
      authMode: AUTH_MODE_SUBSCRIPTION,
      isDefault: true,
      enabled: true,
    },
    select: { apiKeyEnc: true },
  });
  if (!row?.apiKeyEnc) return null;
  return decryptSubscriptionToken(row.apiKeyEnc, `default account for ${userId}`);
}

/** Shared decrypt-or-degrade used by both dispatch paths. Never throws. */
export function decryptSubscriptionToken(enc: string, describe: string): string | null {
  try {
    return decryptSecret(enc) || null;
  } catch (e) {
    log.warn(`claude subscription token (${describe}) failed to decrypt: ${(e as Error).message}`);
    return null;
  }
}
