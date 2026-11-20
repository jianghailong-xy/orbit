import { Module } from '@nestjs/common';
import { DriveChunksService } from './drive-chunks.service';
import { DriveController } from './drive.controller';
import { DriveService } from './drive.service';

// The drive (docs/orbit-files-drive-technical-design.md): the chunk door and the name layer, with the owner's routes.
// PrismaService, FilesService and RealtimeService come from their global modules.
@Module({
  controllers: [DriveController],
  providers: [DriveService, DriveChunksService],
  exports: [DriveService, DriveChunksService],
})
export class DriveModule {}
