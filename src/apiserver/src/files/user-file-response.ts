import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';

/**
 * The types a browser shows without running anything the file carries: raster pictures and PDFs.
 * Every other type leaves as a download. The web client keeps the same list (src/web/src/lib/userFile.ts).
 */
const INLINE_TYPES = new Set([
  'application/pdf',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
]);

/** The bare media type a file may be shown under, or null when it is not on the list. */
export function inlineType(type: string): string | null {
  const bare = type.split(';', 1)[0].trim().toLowerCase();
  return INLINE_TYPES.has(bare) ? bare : null;
}

/** Save this file, under this name: an ASCII name for old clients, and the real one beside it. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]|["\\\r\n]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * The rule for bytes somebody else wrote, on every answer that carries them. A file opened from Orbit's
 * own origin would otherwise run there, beside the login. So no answer may be sniffed into something
 * else, none is a document with an origin (sandbox), a type off the list is never shown, and a type on
 * it leaves bare: what the client sent as a type could read differently to a browser than it does here.
 */
function applyUserFileRule(response: Pick<Response, 'setHeader'>, file: StreamableFile): void {
  const { type, disposition } = file.getHeaders();
  const shown = inlineType(type);
  response.setHeader('Content-Security-Policy', 'sandbox');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (shown) response.setHeader('Content-Type', shown);
  else if (!String(disposition).startsWith('attachment')) response.setHeader('Content-Disposition', 'attachment');
}

/**
 * Applied to every route of the application (FilesModule), so that a door cannot be opened without the
 * rule: whatever answers with a StreamableFile is held to it.
 */
@Injectable()
export class UserFileResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body: unknown) => {
        if (body instanceof StreamableFile) applyUserFileRule(context.switchToHttp().getResponse<Response>(), body);
        return body;
      }),
    );
  }
}
