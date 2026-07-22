import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

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
          signOptions: { expiresIn: config.get<string>('ACCESS_TOKEN_TTL') ?? '7d' },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
