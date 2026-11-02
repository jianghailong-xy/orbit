import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { lastValueFrom, of, type Observable } from 'rxjs';
import { removeTempFile } from './file-store';

/**
 * Removes an upload's temporary file however its request ends. FILE_UPLOAD_STORAGE has the whole file on disk
 * before anything in the route has read the request, and multer removes it only when multer itself failed. After
 * that a pipe can refuse the request without the handler ever being entered (PublicIdPipe, on a malformed id), so
 * cleanup inside a handler cannot see every ending. Both upload routes declare this before multer's interceptor,
 * which leaves everything after multer inside `next.handle()`: the pipes, the handler, and any refusal from either.
 *
 * A kept upload has nothing left to remove: the file store already has it. The removal is awaited, which rxjs
 * `finalize` cannot do, so that a client holding its answer finds no temporary file.
 */
@Injectable()
export class FileUploadCleanupInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<{ file?: { path?: string } }>();
    try {
      return of(await lastValueFrom(next.handle()));
    } finally {
      if (request.file?.path) await removeTempFile(request.file.path);
    }
  }
}
