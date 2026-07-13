import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { CreateSessionTagDto, UpdateSessionTagDto } from './dto';
import { SessionTagsService } from './session-tags.service';

@UseGuards(JwtAuthGuard)
@Controller('session-tags')
export class SessionTagsController {
  constructor(private readonly tags: SessionTagsService) {}

  /** The caller's tag library (system tags seeded + always included). */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tags.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSessionTagDto) {
    return this.tags.create(user.userId, dto);
  }

  /** Rename or recolor a custom tag (system tags are rejected). */
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateSessionTagDto) {
    return this.tags.update(user.userId, id, dto);
  }

  /** Delete a custom tag (system tags are rejected); its links cascade away. */
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tags.remove(user.userId, id);
  }
}
