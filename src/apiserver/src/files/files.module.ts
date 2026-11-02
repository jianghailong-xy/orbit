import { Global, Module } from '@nestjs/common';
import { FilesService } from './files.service';

// Global, like PrismaModule: the attachment doors, the runner door, sessions and tasks all read and keep
// attachment bytes through the one FilesService, built once from the environment at boot (where a
// configuration that cannot work stops the server). AttachmentsModule imports it, which is what puts it in
// the application. The services that also build without Nest take it as optional and fall back to their own
// instance over the same PrismaService, which reads the same environment.
@Global()
@Module({
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
