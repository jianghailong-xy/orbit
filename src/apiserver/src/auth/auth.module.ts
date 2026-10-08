import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { AccessTokensController, PatSelfController } from './access-tokens.controller';
import { AdminSignInController } from './admin-sign-in.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DisabledAccounts } from './disabled-accounts';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleLoginService } from './google-login.service';
import { GoogleOAuthClient } from './google-oauth.client';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatDeviceLoginController } from './pat-device-login.controller';
import { PatDeviceLoginService } from './pat-device-login.service';
import { PatRefusalInterceptor, PatRequestAudit } from './pat-request-audit';
import { PatService } from './pat.service';
import { SignInProvidersService } from './sign-in-providers.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret) {
          throw new Error('JWT_SECRET is required (refusing to start with a forgeable default)');
        }
        return {
          secret,
          // Access-token lifetime. Env-configurable so a deployment can shorten it (e.g. 1h)
          // once all clients ship refresh-token support; kept at 7d by default so clients that
          // predate auto-refresh aren't forced to re-login more often during rollout.
          signOptions: {
            expiresIn: config.get<JwtSignOptions['expiresIn']>('ACCESS_TOKEN_TTL') ?? '7d',
          },
        };
      },
    }),
  ],
  controllers: [
    AuthController,
    AccessTokensController,
    PatSelfController,
    PatDeviceLoginController,
    GoogleAuthController,
    AdminSignInController,
  ],
  providers: [
    AuthService,
    JwtAuthGuard,
    // One per process, so every JwtAuthGuard reads the same accounts and one timer reads them again.
    DisabledAccounts,
    PatService,
    PatDeviceLoginService,
    PatRequestAudit,
    SignInProvidersService,
    GoogleLoginService,
    // Google's endpoints over the global fetch; the specs hand GoogleLoginService a fake in its place.
    { provide: GoogleOAuthClient, useFactory: () => new GoogleOAuthClient() },
    // For AdminSignInController's @UseGuards; it depends only on the global PrismaService, and
    // UsersModule does not export it (ProvidersModule provides its own the same way).
    AdminRoleGuard,
    // Global, as every APP_INTERCEPTOR is: a field only the owner sets is refused past JwtAuthGuard,
    // and the request audit records that refusal as it records the guard's.
    { provide: APP_INTERCEPTOR, useClass: PatRefusalInterceptor },
  ],
  // PatService, PatRequestAudit and DisabledAccounts are exported because JwtAuthGuard is instantiated in every
  // module that uses it, PatService also because admin/* lists and revokes a user's tokens, GoogleLoginService
  // because admin/* unlinks a user's Google account, and DisabledAccounts also because admin/* disables one.
  exports: [JwtAuthGuard, JwtModule, PatService, PatRequestAudit, GoogleLoginService, DisabledAccounts],
})
export class AuthModule {}
