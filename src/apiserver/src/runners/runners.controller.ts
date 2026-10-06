import { PauseAccountDto } from '../common/account-pause';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { isLoginEngine } from '../common/runner-engines';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import {
  CreateEnrollmentTokenDto,
  RenameAccountDto,
  ReorderRunnersDto,
  StartInstallDto,
  StartLoginDto,
  SubmitLoginCodeDto,
  UpdateRunnerDto,
} from './dto';
import { RunnersService } from './runners.service';

@UseGuards(JwtAuthGuard)
@Controller('runners')
export class RunnersController {
  constructor(private readonly runners: RunnersService) {}

  @PatScope('runners:read', { workspaceConfinable: false })
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.runners.listRunners(user.userId);
  }

  // Keep this static route before every `:id` route so Nest never interprets
  // "reorder" as a runner id.
  @PatForbidden('RUNNER_CONTROL')
  @Post('reorder')
  reorder(@CurrentUser() user: AuthUser, @Body() dto: ReorderRunnersDto) {
    return this.runners.reorderRunners(user.userId, dto.ids);
  }

  @PatForbidden('RUNNER_CREDENTIALS')
  @Post('enrollment-tokens')
  createToken(@CurrentUser() user: AuthUser, @Body() dto: CreateEnrollmentTokenDto) {
    return this.runners.createEnrollmentToken(user.userId, dto);
  }

  @PatForbidden('RUNNER_CREDENTIALS')
  @Get('enrollment-tokens')
  listTokens(@CurrentUser() user: AuthUser) {
    return this.runners.listEnrollmentTokens(user.userId);
  }

  @PatForbidden('RUNNER_CREDENTIALS')
  @Get('device/:userCode')
  deviceInfo(@CurrentUser() user: AuthUser, @Param('userCode') userCode: string) {
    return this.runners.getDeviceEnrollment(user.userId, userCode);
  }

  @PatForbidden('RUNNER_CREDENTIALS')
  @Post('device/:userCode/approve')
  approveDevice(@CurrentUser() user: AuthUser, @Param('userCode') userCode: string) {
    return this.runners.approveDeviceEnrollment(user.userId, userCode);
  }

  @PatForbidden('RUNNER_CONTROL')
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateRunnerDto) {
    return this.runners.updateRunner(user.userId, id, dto);
  }

  // Browser-less sign-in relay for one runner. Owner-scoped in the service (a non-owner gets a
  // 404, same as every other :id route here), because these drive credential writes on that
  // machine. The pasted code is single-use and never read back.
  @PatForbidden('RUNNER_CONTROL')
  @Get(':id/login')
  loginState(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.runners.getLoginState(user.userId, id);
  }

  @PatForbidden('RUNNER_CONTROL')
  @Post(':id/login')
  startLogin(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: StartLoginDto) {
    return this.runners.startLogin(user.userId, id, dto ?? {});
  }

  @PatForbidden('RUNNER_CONTROL')
  @Post(':id/login/code')
  submitLoginCode(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: SubmitLoginCodeDto,
  ) {
    return this.runners.submitLoginCode(user.userId, id, dto.code);
  }

  @PatForbidden('RUNNER_CONTROL')
  @Delete(':id/login')
  cancelLogin(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.runners.cancelLogin(user.userId, id);
  }

  // Removing one account of `engine` from a runner: the slot's own directory and the record beside
  // it. Owner-scoped in the service like the relay above, because it deletes credentials on that
  // machine. The account is a slot id or 'default'; the service refuses anything else, and refuses
  // Default itself — that is the login the CLI in a terminal shares.
  @PatForbidden('RUNNER_CONTROL')
  @Delete(':id/accounts/:engine/:account')
  removeAccount(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('engine') engine: string,
    @Param('account') account: string,
  ) {
    if (!isLoginEngine(engine)) throw new BadRequestException('Unknown engine');
    return this.runners.removeAccount(user.userId, id, engine, account);
  }

  // Renaming one account of `engine` on a runner — Default included. Only a label, and Orbit's own:
  // the service keeps it beside the runner's report rather than on the machine, so nothing there
  // changes and the runner need not be online. Owner-scoped like the removal above.
  @PatForbidden('RUNNER_CONTROL')
  @Patch(':id/accounts/:engine/:account')
  renameAccount(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('engine') engine: string,
    @Param('account') account: string,
    @Body() dto: RenameAccountDto,
  ) {
    if (!isLoginEngine(engine)) throw new BadRequestException('Unknown engine');
    return this.runners.renameAccount(user.userId, id, engine, account, dto.name);
  }

  @PatForbidden('RUNNER_CONTROL')
  @Post(':id/accounts/:engine/:account/pause')
  pauseAccount(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('engine') engine: string,
    @Param('account') account: string,
    @Body() dto: PauseAccountDto,
  ) {
    if (!isLoginEngine(engine)) throw new BadRequestException('Unknown engine');
    return this.runners.pauseAccount(user.userId, id, engine, account, dto.durationMinutes);
  }

  // The same removal on Codex's own route, which is what a client older than accounts-per-engine
  // calls. Kept for as long as such a client can reach this build.
  @PatForbidden('RUNNER_CONTROL')
  @Delete(':id/codex-accounts/:account')
  removeCodexAccount(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('account') account: string,
  ) {
    return this.runners.removeCodexAccount(user.userId, id, account);
  }

  // Engine-install relay for one runner, owner-scoped like the sign-in above: it runs an
  // installer on that machine, so only the owner may start one.
  @PatScope('runners:read', { workspaceConfinable: false })
  @Get(':id/install')
  installState(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.runners.getInstallState(user.userId, id);
  }

  @PatForbidden('RUNNER_CONTROL')
  @Post(':id/install')
  startInstall(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: StartInstallDto,
  ) {
    return this.runners.startInstall(user.userId, id, dto.engine);
  }

  @PatForbidden('RUNNER_CONTROL')
  @Delete(':id/install')
  cancelInstall(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.runners.cancelInstall(user.userId, id);
  }

  // Update every engine CLI on this machine now — the periodic pass, on demand. Shares the relay
  // slot (and so the DELETE above) with installs, since both run a package manager there.
  @PatForbidden('RUNNER_CONTROL')
  @Post(':id/engine-update')
  startEngineUpdate(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.runners.startEngineUpdate(user.userId, id);
  }

  // Re-read this machine's runtime model lists now, rather than waiting for the runner's own
  // periodic pass. Owner-scoped like the controls above: it runs CLIs on that machine.
  @PatForbidden('RUNNER_CONTROL')
  @Post(':id/refresh-models')
  refreshModels(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.runners.requestModelCatalogRefresh(user.userId, id);
  }

  // What Claude Code history already sits under a directory on this machine, asked while someone
  // is typing that directory into the new-workspace form. Owner-scoped like the relays above: it
  // reads that machine's own transcripts. The POST asks, the GET waits for the answer.
  @PatForbidden('RUNNER_CONTROL')
  @Post(':id/claude-history')
  askClaudeHistory(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: { workDir?: string },
  ) {
    return this.runners.requestClaudeHistory(user.userId, id, dto?.workDir ?? '');
  }

  @PatForbidden('RUNNER_CONTROL')
  @Get(':id/claude-history')
  claudeHistory(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('workDir') workDir?: string,
  ) {
    return this.runners.getClaudeHistory(user.userId, id, workDir ?? '');
  }

  @PatForbidden('RUNNER_CREDENTIALS')
  @Post(':id/rotate-token')
  rotateToken(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.runners.rotateToken(user.userId, id);
  }

  @PatForbidden('RUNNER_CONTROL')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.runners.removeRunner(user.userId, id);
  }
}
