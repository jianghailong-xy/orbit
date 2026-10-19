import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { AdminProvidersController } from './admin-providers.controller';
import { CodexLoginService } from './codex-login.service';
import { DeepSeekBalanceService } from './deepseek-balance.service';
import {
  CHATGPT_CODEX_BASE,
  OPENAI_OAUTH_TOKEN_URL,
  POOL_LOGIN_TOKEN_ENDPOINT,
  POOL_LOGIN_UPSTREAM,
} from './codex-login-gateway';
import { ModelCatalogService } from './model-catalog.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { PoolGatewayController } from './pool-gateway.controller';
import { OPENAI_API_BASE, POOL_GATEWAY_UPSTREAM, PoolGatewayService } from './pool-gateway.service';
import { PoolLoginGatewayService } from './pool-login-gateway.service';
import { PoolLoginLedger } from './pool-login-ledger';
import { PoolUsageLedger } from './pool-usage-ledger';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { SharedPoolsController } from './shared-pools.controller';
import { SharedPoolsService } from './shared-pools.service';

@Module({
  controllers: [ProvidersController, AdminProvidersController, SharedPoolsController, PoolGatewayController],
  // AdminRoleGuard depends only on the global PrismaService, so provide it here too (it is
  // not exported from UsersModule) for the admin controller's @UseGuards.
  providers: [
    ProvidersService,
    ModelCatalogService,
    ProviderPlanUsageService,
    // The DeepSeek account balance of a DeepSeek key, read with the stored key and cached per key.
    DeepSeekBalanceService,
    AdminRoleGuard,
    SharedPoolsService,
    // The ChatGPT sign-in of a personal Codex pool (migration 0323): it spawns the official codex CLI's
    // device flow and stores what the CLI leaves, encrypted. Its own controller uses it, and the login
    // pools' gateway for what the backend says of the account (spent, signed out) — the pool view reads
    // the row straight from the table, so nothing else has to hand a token around.
    CodexLoginService,
    PoolGatewayService,
    PoolUsageLedger,
    // The shared pools' gateway forwards to OpenAI and nowhere else (pool-gateway.service.ts).
    { provide: POOL_GATEWAY_UPSTREAM, useValue: OPENAI_API_BASE },
    // A login pool's gateway (migration 0324) forwards to ChatGPT's Codex backend and refreshes on
    // OpenAI's token endpoint, and nowhere else (pool-login-gateway.service.ts).
    PoolLoginGatewayService,
    PoolLoginLedger,
    { provide: POOL_LOGIN_UPSTREAM, useValue: CHATGPT_CODEX_BASE },
    { provide: POOL_LOGIN_TOKEN_ENDPOINT, useValue: OPENAI_OAUTH_TOKEN_URL },
  ],
  // For RunnerApiModule's provider list, and for QueueModule's claim, which reads an account pool's
  // quota. Exported rather than re-provided there: a second provider entry would be a second
  // instance — for the quota, a second cache that starts cold — which is how the auto-run sweep
  // once ran twice.
  exports: [ProvidersService, ProviderPlanUsageService],
})
export class ProvidersModule {}
