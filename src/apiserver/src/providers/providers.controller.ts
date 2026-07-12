import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProvidersService } from './providers.service';

/**
 * De-sensitized provider catalog for the pickers. Any signed-in user can read it (usage is
 * not access-controlled by design); it never carries the API key or endpoint. Managing
 * providers (create/edit/rotate key) is the admin-only AdminProvidersController.
 */
@UseGuards(JwtAuthGuard)
@Controller('providers')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  list() {
    return this.providers.listPublic();
  }
}
