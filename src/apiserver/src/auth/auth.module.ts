import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatRefusalInterceptor, PatRequestAudit } from './pat-request-audit';
import { PatService } from './pat.service';

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
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    PatService,
    PatRequestAudit,
    // Global, as every APP_INTERCEPTOR is: a field only the owner sets is refused past JwtAuthGuard,
    // and the request audit records that refusal as it records the guard's.
    { provide: APP_INTERCEPTOR, useClass: PatRefusalInterceptor },
  ],
  // PatService and PatRequestAudit are exported because JwtAuthGuard is instantiated in every module that uses it.
  exports: [JwtAuthGuard, JwtModule, PatService, PatRequestAudit],
})
export class AuthModule {}
