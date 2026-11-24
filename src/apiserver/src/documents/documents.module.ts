import { Module } from '@nestjs/common';
import { DocumentsChunksService } from './documents-chunks.service';
import { DocumentsContentService } from './documents-content.service';
import { DocumentsDownloadLinks } from './documents-download-links';
import { DocumentsUploadsService } from './documents-uploads.service';
import { DocumentsController, DocumentsDownloadController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { RunnerDocumentsController } from './runner-documents.controller';
import { RunnerDocumentsSyncsController } from './runner-documents-syncs.controller';
import { DocumentsSyncsService } from './documents-syncs.service';

// The drive (docs/documents-drive-technical-design.md): the chunk door and the name layer, with the owner's routes and
// the runner drive door.
// PrismaService, FilesService and RealtimeService come from their global modules.
@Module({
  controllers: [DocumentsController, DocumentsDownloadController, RunnerDocumentsController, RunnerDocumentsSyncsController],
  providers: [DocumentsService, DocumentsChunksService, DocumentsUploadsService, DocumentsContentService, DocumentsDownloadLinks, DocumentsSyncsService],
  exports: [DocumentsService, DocumentsChunksService, DocumentsContentService],
})
export class DocumentsModule {}
