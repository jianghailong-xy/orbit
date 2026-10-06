import type { Prisma } from '@prisma/client';
import { GOOGLE } from '../auth/sign-in-providers.service';

/**
 * How an account signs in, as `GET /users/me` and each row of `GET /admin/users` answer it
 * (docs/google-sign-in-design.md §6): whether it has a password, and the Google account linked to it
 * by the email Google last gave. Nothing else of either: not the hash, and of the identity neither
 * Google's `sub` nor its Workspace domain.
 */
export interface AccountSignInMethods {
  password: boolean;
  google: { email: string } | null;
}

/** What a read of `user` selects so that `signInMethodsOf` can answer it. */
export const SIGN_IN_METHODS_SELECT = {
  passwordHash: true,
  identities: { where: { provider: GOOGLE }, select: { email: true } },
} satisfies Prisma.UserSelect;

/** An account read with SIGN_IN_METHODS_SELECT, answered as its sign-in methods. */
export function signInMethodsOf(account: { passwordHash: string | null; identities: Array<{ email: string }> }): AccountSignInMethods {
  const [google] = account.identities;
  return { password: account.passwordHash !== null, google: google ? { email: google.email } : null };
}
