import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { CreateModelProviderDto, UpdateModelProviderDto } from './dto';
import { ProvidersService } from './providers.service';

/**
 * Admin-only management of control-plane model providers (the endpoint + encrypted key that
 * "usage is not access-controlled" providers borrow). Gated like the user-management area:
 * JwtAuthGuard sets the user, AdminRoleGuard checks the role per request.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@Controller('admin/providers')
export class AdminProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  list() {
    return this.providers.listAdmin();
  }

  @Post()
  create(@Body() dto: CreateModelProviderDto) {
    return this.providers.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateModelProviderDto) {
    return this.providers.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.providers.remove(id);
  }
}
