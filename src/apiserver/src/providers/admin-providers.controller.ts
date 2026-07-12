import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { CreateModelProviderDto, UpdateModelProviderDto } from './dto';
import { ProvidersService } from './providers.service';

/**
 * Admin-only management of the SHARED model providers (ownerId null — visible to every
 * user's pickers). Personal (BYOK) providers are each user's own, managed via
 * /providers/mine; they never appear here. Gated like the user-management area.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@Controller('admin/providers')
export class AdminProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  list() {
    return this.providers.listShared();
  }

  @Post()
  create(@Body() dto: CreateModelProviderDto) {
    return this.providers.create(null, dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateModelProviderDto) {
    return this.providers.update(null, id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.providers.remove(null, id);
  }
}
