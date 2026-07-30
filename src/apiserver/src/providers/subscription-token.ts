import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from './provider-crypto';

const log = new Logger('SubscriptionToken');

/**
 * A user's Claude subscription token (`claude setup-token`), decrypted for injection as
 * CLAUDE_CODE_OAUTH_TOKEN at dispatch. Unlike a ModelProvider row this doesn't redirect the
 * endpoint — it only supplies credentials — so it applies to the built-in claude runtime on
 * every runner the user dispatches to.
 *
 * Returns null for "no token configured" AND for a token that won't decrypt (e.g. the
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
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { claudeOauthTokenEnc: true },
  });
  if (!row?.claudeOauthTokenEnc) return null;
  try {
    return decryptSecret(row.claudeOauthTokenEnc) || null;
  } catch (e) {
    log.warn(`claude subscription token for ${userId} failed to decrypt: ${(e as Error).message}`);
    return null;
  }
}
