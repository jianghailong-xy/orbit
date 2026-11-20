import { Module } from '@nestjs/common';
import { DriveChunksService } from './drive-chunks.service';
import { DriveController } from './drive.controller';
import { DriveService } from './drive.service';
import { RunnerDriveController } from './runner-drive.controller';

// The drive (docs/orbit-files-drive-technical-design.md): the chunk door and the name layer, with the owner's routes and
// the runner drive door.
// PrismaService, FilesService and RealtimeService come from their global modules.
@Module({
  controllers: [DriveController, RunnerDriveController],
  providers: [DriveService, DriveChunksService],
  exports: [DriveService, DriveChunksService],
})
export class DriveModule {}
