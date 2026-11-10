import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { ReplaceAccountSecretDto } from './dto';
import { OwnerSecretsService, refuseActingSession } from './owner-secrets.service';

/**
 * The owner's saved secrets (design docs/design/owner-request-secrets.md §3.4): write-only. The list names labels and
 * dates, and no route returns a value or anything derived from one, not even to the owner. A saved secret is made by
 * "Save to my account secrets" on a SECRET card and used by "Use saved" there, always by the owner's own click.
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
  ): Promise<void> {
    refuseActingSession(request.headers);
    await this.secrets.deleteSaved(user.userId, id);
  }
}
