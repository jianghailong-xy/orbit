import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import {
  CreateEnrollmentTokenDto,
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

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.runners.listRunners(user.userId);
  }

  // Keep this static route before every `:id` route so Nest never interprets
  // "reorder" as a runner id.
  @Post('reorder')
  reorder(@CurrentUser() user: AuthUser, @Body() dto: ReorderRunnersDto) {
    return this.runners.reorderRunners(user.userId, dto.ids);
  }

  @Post('enrollment-tokens')
  createToken(@CurrentUser() user: AuthUser, @Body() dto: CreateEnrollmentTokenDto) {
    return this.runners.createEnrollmentToken(user.userId, dto);
  }

  @Get('enrollment-tokens')
  listTokens(@CurrentUser() user: AuthUser) {
    return this.runners.listEnrollmentTokens(user.userId);
  }

  @Get('device/:userCode')
  deviceInfo(@CurrentUser() user: AuthUser, @Param('userCode') userCode: string) {
    return this.runners.getDeviceEnrollment(user.userId, userCode);
  }

  @Post('device/:userCode/approve')
  approveDevice(@CurrentUser() user: AuthUser, @Param('userCode') userCode: string) {
    return this.runners.approveDeviceEnrollment(user.userId, userCode);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateRunnerDto) {
    return this.runners.updateRunner(user.userId, id, dto);
  }

  // Browser-less sign-in relay for one runner. Owner-scoped in the service (a non-owner gets a
  // 404, same as every other :id route here), because these drive credential writes on that
  // machine. The pasted code is single-use and never read back.
  @Get(':id/login')
  loginState(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runners.getLoginState(user.userId, id);
  }

  @Post(':id/login')
  startLogin(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: StartLoginDto) {
    return this.runners.startLogin(user.userId, id, dto?.engine ?? 'claude');
  }

  @Post(':id/login/code')
  submitLoginCode(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SubmitLoginCodeDto,
  ) {
    return this.runners.submitLoginCode(user.userId, id, dto.code);
  }

  @Delete(':id/login')
  cancelLogin(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runners.cancelLogin(user.userId, id);
  }

  // Engine-install relay for one runner, owner-scoped like the sign-in above: it runs an
  // installer on that machine, so only the owner may start one.
  @Get(':id/install')
  installState(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runners.getInstallState(user.userId, id);
  }

  @Post(':id/install')
  startInstall(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: StartInstallDto,
  ) {
    return this.runners.startInstall(user.userId, id, dto.engine);
  }

  @Delete(':id/install')
  cancelInstall(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runners.cancelInstall(user.userId, id);
  }

  // Update every engine CLI on this machine now — the daily pass, on demand. Shares the relay
  // slot (and so the DELETE above) with installs, since both run a package manager there.
  @Post(':id/engine-update')
  startEngineUpdate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runners.startEngineUpdate(user.userId, id);
  }

  @Post(':id/rotate-token')
  rotateToken(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runners.rotateToken(user.userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runners.removeRunner(user.userId, id);
  }
}
