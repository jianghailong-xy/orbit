import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { UpdateGoogleSignInDto } from './dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatForbidden } from './pat-scope.decorator';
import { SignInProvidersService } from './sign-in-providers.service';

/**
 * The admin area's Sign-in settings (docs/google-sign-in-design.md §7.1): the Google OAuth client
 * this deployment signs in with, and who may sign up through it. Gated like the user-management
 * area. The client secret goes in and never comes back out: every answer says only whether one is
 * saved.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin/sign-in')
export class AdminSignInController {
  constructor(private readonly signIn: SignInProvidersService) {}

  @Get('google')
  google() {
    return this.signIn.googleSettings();
  }

  /** Saves the whole setting. A body without `clientSecret` keeps the saved one. */
  @Put('google')
  updateGoogle(@CurrentUser() admin: AuthUser, @Body() dto: UpdateGoogleSignInDto) {
    return this.signIn.updateGoogle(admin.userId, dto);
  }
}
