import { Body, Controller, Get, Inject, Optional, Post, UseGuards } from '@nestjs/common';
import { MANAGED_RUNNER_CONTRACT_VERSION, type ServerCapabilities } from '@orbit/shared';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { MANAGED_RUNNER_GATE, MANAGED_RUNNERS_OFF, type ManagedRunnerGate } from '../managed-runners/managed-runner-gate';
import { AuthService } from './auth.service';
import { BootstrapDto, ChangePasswordDto, LoginDto, RefreshDto } from './dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatForbidden } from './pat-scope.decorator';
import { SignInProvidersService } from './sign-in-providers.service';

@PatForbidden('AUTH')
@Controller('auth')
export class AuthController {
  private readonly managedRunners: ManagedRunnerGate;

  constructor(
    private readonly auth: AuthService,
    private readonly signIn: SignInProvidersService,
    // The process's managed runner switch; a module graph without it has the feature off.
    @Optional() @Inject(MANAGED_RUNNER_GATE) managedRunners?: ManagedRunnerGate,
  ) {
    this.managedRunners = managedRunners ?? MANAGED_RUNNERS_OFF;
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Public: the ways this deployment signs people in, so a login page offers Google only when it
   *  is on (docs/google-sign-in-design.md §6). */
  @Get('methods')
  methods() {
    return this.signIn.methods();
  }

  /** Public: whether the system still has zero users, so the web can funnel to /setup. */
  @Get('setup-status')
  setupStatus() {
    return this.auth.getSetupStatus();
  }

  /** Public first-run endpoint: create the first user and return a session token.
   *  Self-closes once any user exists (trust-on-first-use). */
  @Post('bootstrap')
  bootstrap(@Body() dto: BootstrapDto) {
    return this.auth.bootstrap(dto.email, dto.name, dto.password);
  }

  /** Public: swap a valid refresh token for a fresh access+refresh pair. No bearer guard — the
   *  access token may already be expired; the refresh token itself is the credential. */
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /** Public: revoke a refresh token on sign-out. The token is the credential (idempotent). */
  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  /** What optional features this server offers a signed-in client (docs/managed-runner-design.md,
   *  "Server and three client interfaces"). Answered from the process's switch alone: it reads no
   *  cluster, allocates nothing and writes nothing. */
  @UseGuards(JwtAuthGuard)
  @Get('capabilities')
  capabilities(): ServerCapabilities {
    return {
      managedRunners: { enabled: this.managedRunners.enabled, contractVersion: MANAGED_RUNNER_CONTRACT_VERSION },
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.userId, dto.currentPassword, dto.newPassword, dto.revokeAccessTokens === true);
  }
}
