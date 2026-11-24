import { Body, Controller, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { CurrentRunner } from '../runner-api/current-runner.decorator';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RUNNER_DRIVE_ROUTE_PREFIXES } from './drive-routes';
import { DriveEnabledGuard } from './drive-switch';
import { DriveSyncsService } from './drive-syncs.service';
import { RunnerDriveSyncOpenDto, RunnerDriveSyncReportDto } from './runner-drive.dto';

/**
 * Where `orbit documents sync` reports how far it has got (docs/drive-directory-sync-design.md S4), for the owner's
 * upload tray. The runner credential only: unlike the runner Drive door, a mount credential reaches none of it, since a mount
 * never syncs. The owner is the credential's, and a sync is reported into only by the runner that opened it.
 */
@UseGuards(RunnerAuthGuard, DriveEnabledGuard)
@Controller(RUNNER_DRIVE_ROUTE_PREFIXES.map((prefix) => `${prefix}/syncs`))
export class RunnerDriveSyncsController {
  constructor(private readonly syncs: DriveSyncsService) {}

  /** A sync starts: its row, which the tray shows as Checking. */
  @Post()
  open(@CurrentRunner() runner: Runner, @Body() dto: RunnerDriveSyncOpenDto) {
    return this.syncs.open(runner, { sourceName: dto.sourceName, destPath: dto.destPath, sessionId: dto.sessionId ?? null });
  }

  /** The counts as they are now; DONE, FAILED or STOPPED ends the sync. */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  report(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string, @Body() dto: RunnerDriveSyncReportDto) {
    return this.syncs.report(runner, id, dto);
  }
}
