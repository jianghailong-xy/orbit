import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PauseAccountDto } from '../common/account-pause';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import {
  AddProviderPoolMemberDto,
  CreateModelProviderDto,
  CreateProviderPoolDto,
  TestModelProviderDto,
  UpdateModelProviderDto,
} from './dto';
import { CodexLoginService } from './codex-login.service';
import { ProvidersService } from './providers.service';

/**
 * Model providers for signed-in users. GET / is the de-sensitized picker catalog (shared +
 * the caller's own; never a key or endpoint). The /mine routes are each user's personal
 * (BYOK) providers — owner-scoped CRUD (including reading back one's own key), no role gate. Shared providers are managed in the
 * admin-only AdminProvidersController.
 */
@UseGuards(JwtAuthGuard)
@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly codexLogin: CodexLoginService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.providers.listPublic(user.userId);
  }

  @Get('mine')
  listMine(@CurrentUser() user: AuthUser) {
    return this.providers.listMine(user.userId);
  }

  // The stored key of one of the caller's own providers, in the clear — what the edit form fills
  // its key field from. Owner-scoped: there is no route here that reveals a shared provider's key.
  @Get('mine/:id/key')
  revealMineKey(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.providers.revealKey(user.userId, id);
  }

  // The vendor presets' current model lists, for the connect form. Public catalogue data (no key,
  // no endpoint) that the browser can't derive: its copy is whatever shipped in the bundle, while
  // this one carries the latest models.dev refresh.
  @Get('presets')
  presets() {
    return this.providers.presetModels();
  }

  // Stateless key/endpoint probe for the add/edit form — any signed-in user, own inputs only.
  @Post('test')
  test(@Body() dto: TestModelProviderDto) {
    return this.providers.testConnection(dto);
  }

  @Post('mine')
  createMine(@CurrentUser() user: AuthUser, @Body() dto: CreateModelProviderDto) {
    return this.providers.create(user.userId, dto);
  }

  @Patch('mine/:id')
  updateMine(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateModelProviderDto) {
    return this.providers.update(user.userId, id, dto);
  }

  @Delete('mine/:id')
  removeMine(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.providers.remove(user.userId, id);
  }

  // Account pools: several of the caller's own subscription providers dispatched under one slug.
  // Owner-scoped like /mine. A provider that could never be chosen from a pool is refused with the
  // reason, not accepted.
  @Get('pools')
  listPools(@CurrentUser() user: AuthUser) {
    return this.providers.listPools(user.userId);
  }

  @Post('pools')
  createPool(@CurrentUser() user: AuthUser, @Body() dto: CreateProviderPoolDto) {
    return this.providers.createPool(user.userId, dto);
  }

  @Delete('pools/:id')
  removePool(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.providers.removePool(user.userId, id);
  }

  @Post('pools/:id/members')
  addPoolMember(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: AddProviderPoolMemberDto,
  ) {
    return this.providers.addPoolMember(user.userId, id, dto.providerId);
  }

  @Post('pools/:id/members/:memberId/pause')
  pausePoolMember(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('memberId', PublicIdPipe.allowingPrefixed('login:')) memberId: string,
    @Body() dto: PauseAccountDto,
  ) {
    return this.providers.pausePoolMember(user.userId, id, memberId, dto.durationMinutes);
  }

  @Delete('pools/:id/members/:providerId')
  removePoolMember(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('providerId', PublicIdPipe) providerId: string,
  ) {
    return this.providers.removePoolMember(user.userId, id, providerId);
  }

  // One of the caller's pools, as its page reads it: the members it holds and — for a Codex pool of
  // their own — the ChatGPT accounts it holds (migration 0323), by email and masked either way. Another
  // owner's pool answers 404, as it does on every route here.
  @Get('pools/:id')
  getPool(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.providers.getPool(user.userId, id);
  }

  // The ChatGPT login of one of the caller's own Codex pools: the OFFICIAL codex CLI's device flow, run
  // on this server in a throwaway CODEX_HOME. POST starts it and answers with the page to open and the
  // one-time code to type there; GET is the poll — the first one after the owner approved stores the
  // credential, encrypted, and answers with the account; DELETE gives the attempt up. Nothing any of them
  // returns carries a token: an account is named by its email and `…AB12`.
  //
  // Only the owner of the pool reaches any of this — another user's pool is not found, and an account
  // can be signed in, polled, cancelled or signed out by nobody else.
  @Post('pools/:id/codex-login')
  startCodexLogin(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.codexLogin.start(user.userId, id);
  }

  @Get('pools/:id/codex-login')
  pollCodexLogin(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.codexLogin.poll(user.userId, id);
  }

  @Delete('pools/:id/codex-login')
  cancelCodexLogin(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.codexLogin.cancel(user.userId, id);
  }

  // One account out of the pool, named by its fingerprint (`?fingerprint=…AB12`, as every response names
  // it) — with none, the pool's first, its `login`: the tokens this server held for it go with it, and the
  // pool's other accounts stay. The next sign-in (by the owner, the only one who can) is what puts an
  // account back.
  @Delete('pools/:id/codex-login/account')
  signOutCodexLogin(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('fingerprint') fingerprint?: string,
  ) {
    return this.codexLogin.signOut(user.userId, id, fingerprint);
  }
}
