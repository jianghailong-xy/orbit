import { Injectable } from '@nestjs/common';
import type { SignInProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../providers/provider-crypto';

/** The one sign-in provider there is besides the password (docs/google-sign-in-design.md §2). */
export const GOOGLE = 'google';

/**
 * Who may sign in with Google (§5.6): only accounts that already exist, the default, or any Google
 * account, which gets an account at its first sign-in.
 */
export const SIGNUP_POLICIES = ['EXISTING_ACCOUNTS', 'OPEN'] as const;
export type SignupPolicy = (typeof SIGNUP_POLICIES)[number];

/** `GET /auth/methods`: what a login page offers. */
export interface SignInMethods {
  password: true;
  google: boolean;
  /** Google sign-in is on and creates an account for a Google account that has none. */
  googleSignup: boolean;
}

/** `GET` and `PUT /admin/sign-in/google`. Says whether a secret is saved, never what it is. */
export interface GoogleSignInSettings {
  enabled: boolean;
  clientId: string;
  hasSecret: boolean;
  signupPolicy: SignupPolicy;
  /** What to register in the Google console as the client's authorized redirect URI. */
  redirectUri: string;
}

export interface GoogleSignInChange {
  enabled: boolean;
  clientId: string;
  /** Left out, the saved secret stays. */
  clientSecret?: string;
  signupPolicy: SignupPolicy;
}

/**
 * The one address Google sends a browser back to (§4.1): this deployment's PUBLIC_ORIGIN, read as
 * providers/shared-pool.ts reads it, and the callback route.
 */
export function googleRedirectUri(): string {
  const origin = (process.env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/, '');
  return `${origin}/api/auth/google/callback`;
}

/** On only when enabled and both the client ID and the secret are saved (§7.1); the empty string is none. */
function googleIsOn(row: SignInProvider | null): row is SignInProvider {
  return row !== null && row.enabled && row.clientId !== '' && row.clientSecretEnc !== '';
}

function settingsOf(row: SignInProvider | null): GoogleSignInSettings {
  return {
    enabled: row?.enabled ?? false,
    clientId: row?.clientId ?? '',
    hasSecret: (row?.clientSecretEnc ?? '') !== '',
    signupPolicy: (row?.signupPolicy ?? 'EXISTING_ACCOUNTS') as SignupPolicy,
    redirectUri: googleRedirectUri(),
  };
}

/**
 * The sign-in providers an administrator configures in the admin area (`sign_in_provider`,
 * migration 0387). No row and a row that is off are the same: every Google route refuses and the
 * login page offers the password alone, as before there was a table. Read on every request, so a
 * change an administrator saves holds from the next one.
 */
@Injectable()
export class SignInProvidersService {
  constructor(private readonly prisma: PrismaService) {}

  private google(): Promise<SignInProvider | null> {
    return this.prisma.signInProvider.findUnique({ where: { provider: GOOGLE } });
  }

  async methods(): Promise<SignInMethods> {
    const row = await this.google();
    if (!googleIsOn(row)) return { password: true, google: false, googleSignup: false };
    return { password: true, google: true, googleSignup: row.signupPolicy === 'OPEN' };
  }

  async googleSettings(): Promise<GoogleSignInSettings> {
    return settingsOf(await this.google());
  }

  /** One upsert of the whole setting. A secret given replaces the saved one; none given keeps it. */
  async updateGoogle(adminId: string, change: GoogleSignInChange): Promise<GoogleSignInSettings> {
    const secret = change.clientSecret ? encryptSecret(change.clientSecret) : undefined;
    const fields = {
      enabled: change.enabled,
      clientId: change.clientId,
      signupPolicy: change.signupPolicy,
      updatedById: adminId,
    };
    const row = await this.prisma.signInProvider.upsert({
      where: { provider: GOOGLE },
      create: { provider: GOOGLE, ...fields, clientSecretEnc: secret ?? '' },
      update: secret === undefined ? fields : { ...fields, clientSecretEnc: secret },
    });
    return settingsOf(row);
  }

  /** The client the Google routes sign in with, its secret decrypted; null while Google sign-in is off. */
  async googleClient(): Promise<{ clientId: string; clientSecret: string; signupPolicy: SignupPolicy } | null> {
    const row = await this.google();
    if (!googleIsOn(row)) return null;
    return {
      clientId: row.clientId,
      clientSecret: decryptSecret(row.clientSecretEnc),
      signupPolicy: row.signupPolicy as SignupPolicy,
    };
  }
}
