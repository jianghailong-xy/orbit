import { Module } from '@nestjs/common';
import { SessionFoldersController } from './session-folders.controller';
import { SessionFoldersService } from './session-folders.service';

@Module({
  controllers: [SessionFoldersController],
  providers: [SessionFoldersService],
})
export class SessionFoldersModule {}
