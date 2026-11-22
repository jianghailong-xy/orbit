import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { CreateAccountSecretDto, ReplaceAccountSecretDto } from './dto';
import { OwnerSecretsService, refuseActingSession } from './owner-secrets.service';

/**
 * The owner's saved secrets (design docs/design/owner-request-secrets.md §3.4): write-only. The list names labels and
 * dates, and no route returns a value or anything derived from one, not even to the owner. A saved secret is made by
 * "Save to my account secrets" on a SECRET card or by Add on the Secrets page, and used by "Use saved" on a card,
 * always by the owner's own click.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('OWNER_INTERACTIVE')
@Controller('account-secrets')
export class AccountSecretsController {
  constructor(private readonly secrets: OwnerSecretsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Req() request: { headers: Record<string, string | string[] | undefined> }) {
    refuseActingSession(request.headers);
    return this.secrets.listSaved(user.userId);
  }

  /**
   * Every copy of a secret on a machine: live (waiting for delivery, active, being removed) and, with `removed=30d`,
   * those removed in the last 30 days. Labels, places, states and dates only.
   */
  @Get('grants')
  grants(
    @CurrentUser() user: AuthUser,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
    @Query('removed') removed?: string,
  ) {
    refuseActingSession(request.headers);
    if (removed !== undefined && removed !== '30d') throw new BadRequestException('removed is 30d or absent');
    return this.secrets.listGrants(user.userId, removed === '30d');
  }

  /** Revoke one copy, as its card's Revoke would: a delivered one is removed, one not delivered yet is cancelled. */
  @Post('grants/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeGrant(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ): Promise<void> {
    refuseActingSession(request.headers);
    await this.secrets.revokeGrant(user.userId, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAccountSecretDto,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    refuseActingSession(request.headers);
    return this.secrets.createSaved(user.userId, dto.label, dto.value);
  }

  @Put(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async replace(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ReplaceAccountSecretDto,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ): Promise<void> {
    refuseActingSession(request.headers);
    await this.secrets.replaceSaved(user.userId, id, dto.value);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
    /** `true` also revokes every live copy made from it, as each card's Revoke would. */
    @Query('revokeCopies') revokeCopies?: string,
  ): Promise<void> {
    refuseActingSession(request.headers);
    await this.secrets.deleteSaved(user.userId, id, revokeCopies === 'true');
  }
}
