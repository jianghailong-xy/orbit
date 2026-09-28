import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import {
  AddPoolKeyDto,
  AddSharedPoolPersonDto,
  CreateSharedPoolDto,
  ReplacePoolKeyDto,
  UpdatePoolKeyDto,
  UpdateSharedPoolDto,
  UpdateSharedPoolPersonDto,
} from './dto';
import { SharedPoolsService } from './shared-pools.service';

/**
 * Shared Codex pools (migration 0320): the pool page's doors. Scoped by who is IN a pool rather than by
 * who owns it — a pool the caller is not in answers 404 from every route here, the same as one that does
 * not exist — and what each person may do there is SharedPoolsService's table. No body any route here
 * answers with carries a key: a key goes in through POST keys and PUT keys/:keyId/secret and never comes
 * back out, `sk-…` and its last four characters being all anyone is shown.
 */
@UseGuards(JwtAuthGuard)
@Controller('providers/shared-pools')
export class SharedPoolsController {
  constructor(private readonly pools: SharedPoolsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.pools.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSharedPoolDto) {
    return this.pools.create(user.userId, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.pools.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateSharedPoolDto) {
    return this.pools.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.pools.remove(user.userId, id);
  }

  @Post(':id/leave')
  leave(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.pools.leave(user.userId, id);
  }

  @Post(':id/people')
  addPerson(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: AddSharedPoolPersonDto) {
    return this.pools.addPerson(user.userId, id, dto);
  }

  @Patch(':id/people/:userId')
  setRole(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('userId', PublicIdPipe) personId: string,
    @Body() dto: UpdateSharedPoolPersonDto,
  ) {
    return this.pools.setRole(user.userId, id, personId, dto);
  }

  @Delete(':id/people/:userId')
  removePerson(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('userId', PublicIdPipe) personId: string,
  ) {
    return this.pools.removePerson(user.userId, id, personId);
  }

  @Post(':id/keys')
  addKey(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: AddPoolKeyDto) {
    return this.pools.addKey(user.userId, id, dto);
  }

  @Patch(':id/keys/:keyId')
  updateKey(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('keyId', PublicIdPipe) keyId: string,
    @Body() dto: UpdatePoolKeyDto,
  ) {
    return this.pools.updateKey(user.userId, id, keyId, dto);
  }

  @Put(':id/keys/:keyId/secret')
  replaceKey(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('keyId', PublicIdPipe) keyId: string,
    @Body() dto: ReplacePoolKeyDto,
  ) {
    return this.pools.replaceKey(user.userId, id, keyId, dto);
  }

  @Delete(':id/keys/:keyId')
  removeKey(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('keyId', PublicIdPipe) keyId: string,
  ) {
    return this.pools.removeKey(user.userId, id, keyId);
  }
}
