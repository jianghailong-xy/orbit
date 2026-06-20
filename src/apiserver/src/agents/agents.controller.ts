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
import { AgentsService } from './agents.service';
import { CreateAgentDto, ReorderAgentsDto, UpdateAgentDto } from './dto';

@UseGuards(JwtAuthGuard)
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAgentDto) {
    return this.agents.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.agents.list(user.userId);
  }

  // Persist the sidebar drag order. Declared before the `:id` routes; the static
  // path keeps it from being shadowed by a param route.
  @Post('reorder')
  reorder(@CurrentUser() user: AuthUser, @Body() dto: ReorderAgentsDto) {
    return this.agents.reorder(user.userId, dto.ids);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.agents.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.agents.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.agents.remove(user.userId, id);
  }
}
