import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type {
  CodexRateLimitResetOperations,
  CodexRateLimitResetOperationView,
  CreateCodexRateLimitResetResponse,
} from '@orbit/shared';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { CodexRateLimitResetService } from './codex-rate-limit-reset.service';

/**
 * Codex earned rate-limit reset, as the account owner's clients reach it
 * (docs/codex-rate-limit-reset-contract.md §6.1). Owner-scoped like every other `runners/:id` route:
 * a runner or an operation that is not the caller's is a 404.
 *
 * No body leaving here carries the provider idempotency key. Every operation is rendered by
 * `codexResetOperationView`, which has no field for it, and a refusal names only a code and an id.
 */
@UseGuards(JwtAuthGuard)
@Controller('runners')
export class CodexRateLimitResetController {
  constructor(private readonly resets: CodexRateLimitResetService) {}

  /** 201 with the operation this confirmation created, 200 with the one it had already created. */
  @Post(':id/codex-rate-limit-reset')
  async create(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body(PublicIdPipe.forFields('workspaceId')) body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreateCodexRateLimitResetResponse> {
    // The pipe hands a blank id through untouched, and the contract's validator asks only for a
    // non-empty string — so "   " would otherwise reach the uuid column as a 500 rather than a 400.
    const workspaceId = (body as { workspaceId?: unknown } | null)?.workspaceId;
    if (typeof workspaceId === 'string' && workspaceId.trim() === '') {
      throw new BadRequestException('body.workspaceId must be a non-empty id');
    }
    const created = await this.resets.create(user.userId, id, body);
    if (created.replayed) res.status(HttpStatus.OK);
    return created;
  }

  @Get(':id/codex-rate-limit-reset')
  list(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<CodexRateLimitResetOperations> {
    return this.resets.operationsFor(user.userId, id);
  }

  // Either spelling of the operation id: a view names it by public id, a refusal by the stored UUID.
  @Get(':id/codex-rate-limit-reset/:operationId')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('operationId', PublicIdPipe) operationId: string,
  ): Promise<CodexRateLimitResetOperationView> {
    return this.resets.operation(user.userId, id, operationId);
  }
}
