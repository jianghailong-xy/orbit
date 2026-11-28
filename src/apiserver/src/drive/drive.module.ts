import { Module } from '@nestjs/common';
import { DriveActivity } from './drive-activity';
import { DriveChunksService } from './drive-chunks.service';
import { DriveChatChanges } from './drive-chat-changes';
import { DriveChatChangesController } from './drive-chat-changes.controller';
import { DriveContentService } from './drive-content.service';
import { DriveDownloadLinks } from './drive-download-links';
import { DriveUploadsService } from './drive-uploads.service';
import { DriveController, DriveDownloadController } from './drive.controller';
import { DriveService } from './drive.service';
import { RunnerDriveController } from './runner-drive.controller';
import { RunnerDriveSyncsController } from './runner-drive-syncs.controller';
import { DriveSyncsService } from './drive-syncs.service';

// The drive (docs/drive-technical-design.md): the chunk door and the name layer, with the owner's routes and
// the runner drive door.
// PrismaService, FilesService and RealtimeService come from their global modules.
@Module({
  controllers: [DriveController, DriveDownloadController, RunnerDriveController, RunnerDriveSyncsController, DriveChatChangesController],
  providers: [DriveService, DriveActivity, DriveChatChanges, DriveChunksService, DriveUploadsService, DriveContentService, DriveDownloadLinks, DriveSyncsService],
  exports: [DriveService, DriveChunksService, DriveContentService],
})
export class DriveModule {}
