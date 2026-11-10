import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { SecretGrantAckDto, SecretGrantRemovedDto } from '../owner-requests/dto';
import { OwnerSecretsService } from '../owner-requests/owner-secrets.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The runner's half of secret delivery (design docs/design/owner-request-secrets.md §4.2, §6.3). Every route reads the
 * grant by (id, the authenticated runner, its owner): another runner's grant — the same owner's second runner included —
 * is the same 404 as an id that does not exist. The heartbeat names grant ids only; the value leaves through `fetch`
 * and nothing else, and none of these log a body.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner/secret-grants')
export class RunnerSecretGrantsController {
  constructor(private readonly secrets: OwnerSecretsService) {}

  @Post(':id/fetch')
  @HttpCode(HttpStatus.OK)
  fetch(@CurrentRunner() runner: Runner, @Param('id', ParseUUIDPipe) id: string) {
    return this.secrets.fetch(runner, id);
  }

  @Post(':id/ack')
  @HttpCode(HttpStatus.OK)
  ack(@CurrentRunner() runner: Runner, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SecretGrantAckDto) {
    return this.secrets.ack(runner, id, dto.outcome, dto.code, dto.message);
  }

  @Post(':id/removed')
  @HttpCode(HttpStatus.OK)
  removed(@CurrentRunner() runner: Runner, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SecretGrantRemovedDto) {
    return this.secrets.removed(runner, id, dto.note);
  }
}
