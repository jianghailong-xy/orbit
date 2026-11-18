import { Module } from '@nestjs/common';
import { WikiModule } from '../wiki/wiki.module';
import { PromptOptimizerController, PromptOptimizerService } from './prompt-optimizer';

/**
 * `POST /prompt-optimizations` (docs/prompt-optimizer-design.md). A module of its own rather than a
 * part of SessionsModule: it reads the wiki through WikiRetrieval, and SessionsModule imports no wiki.
 * It reads sessions, workspaces and projects through Prisma alone.
 */
@Module({
  imports: [WikiModule],
  controllers: [PromptOptimizerController],
  providers: [PromptOptimizerService],
})
export class PromptOptimizerModule {}
