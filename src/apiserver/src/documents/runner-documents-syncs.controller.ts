import { Body, Controller, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { CurrentRunner } from '../runner-api/current-runner.decorator';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RUNNER_DOCUMENTS_ROUTE_PREFIXES } from './documents-routes';
import { DocumentsEnabledGuard } from './documents-switch';
import { DocumentsSyncsService } from './documents-syncs.service';
import { RunnerDocumentsSyncOpenDto, RunnerDocumentsSyncReportDto } from './runner-documents.dto';

/**
 * Where `orbit documents sync` reports how far it has got (docs/documents-directory-sync-design.md S4), for the owner's
 * upload tray. The runner credential only: unlike the runner Documents door, a mount credential reaches none of it, since a mount
 * never syncs. The owner is the credential's, and a sync is reported into only by the runner that opened it.
 */
@UseGuards(RunnerAuthGuard, DocumentsEnabledGuard)
@Controller(RUNNER_DOCUMENTS_ROUTE_PREFIXES.map((prefix) => `${prefix}/syncs`))
export class RunnerDocumentsSyncsController {
  constructor(private readonly syncs: DocumentsSyncsService) {}

  /** A sync starts: its row, which the tray shows as Checking. */
  @Post()
  open(@CurrentRunner() runner: Runner, @Body() dto: RunnerDocumentsSyncOpenDto) {
    return this.syncs.open(runner, { sourceName: dto.sourceName, destPath: dto.destPath, sessionId: dto.sessionId ?? null });
  }

  /** The counts as they are now; DONE, FAILED or STOPPED ends the sync. */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  report(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string, @Body() dto: RunnerDocumentsSyncReportDto) {
    return this.syncs.report(runner, id, dto);
  }
}
