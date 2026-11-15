import { Module } from '@nestjs/common';
import { HelpReaderGuard, HelpController } from './help.controller';
import { HelpLibrary } from './help-library';

/** The help article library, read from docs/help once at boot: a library that does not parse stops the boot. */
@Module({
  controllers: [HelpController],
  providers: [HelpReaderGuard, { provide: HelpLibrary, useFactory: () => HelpLibrary.load() }],
})
export class HelpModule {}
