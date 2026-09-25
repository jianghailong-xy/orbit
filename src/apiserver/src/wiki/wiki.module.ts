import { Module } from '@nestjs/common';
import { WikiController } from './wiki.controller';
import { WikiService } from './wiki.service';

/**
 * The Orbit Wiki's own module.
 *
 * It provides exactly one service and injects nothing from Sessions, Projects or Tasks: the wiki is a
 * knowledge store that reads their rows, and a dependency on their services would make one object
 * shared across two feature areas — which is how a hand-built spec that stands the wiki up with a
 * Prisma client alone would fail to construct it. `RunnerApiModule` imports this module for
 * `RunnerWikiController`, so the runner door and the user door answer from one WikiService.
 */
@Module({
  controllers: [WikiController],
  providers: [WikiService],
  exports: [WikiService],
})
export class WikiModule {}
