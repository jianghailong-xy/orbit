import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { CreateEnrollmentTokenDto } from './dto';
import { RunnersService } from './runners.service';

@UseGuards(JwtAuthGuard)
@Controller('runners')
export class RunnersController {
  constructor(private readonly runners: RunnersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.runners.listRunners(user.userId);
  }

  @Post('enrollment-tokens')
  createToken(@CurrentUser() user: AuthUser, @Body() dto: CreateEnrollmentTokenDto) {
    return this.runners.createEnrollmentToken(user.userId, dto);
  }

  @Get('enrollment-tokens')
  listTokens(@CurrentUser() user: AuthUser) {
    return this.runners.listEnrollmentTokens(user.userId);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.runners.removeRunner(user.userId, id);
  }
}
