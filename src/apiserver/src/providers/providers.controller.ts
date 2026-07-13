import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { CreateModelProviderDto, TestModelProviderDto, UpdateModelProviderDto } from './dto';
import { ProvidersService } from './providers.service';

/**
 * Model providers for signed-in users. GET / is the de-sensitized picker catalog (shared +
 * the caller's own; never a key or endpoint). The /mine routes are each user's personal
 * (BYOK) providers — owner-scoped CRUD, no role gate. Shared providers are managed in the
 * admin-only AdminProvidersController.
 */
@UseGuards(JwtAuthGuard)
@Controller('providers')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.providers.listPublic(user.userId);
  }

  @Get('mine')
  listMine(@CurrentUser() user: AuthUser) {
    return this.providers.listMine(user.userId);
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
  updateMine(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateModelProviderDto) {
    return this.providers.update(user.userId, id, dto);
  }

  @Delete('mine/:id')
  removeMine(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.providers.remove(user.userId, id);
  }
}
