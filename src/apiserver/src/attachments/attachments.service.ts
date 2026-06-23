import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertValidUpload, UploadedFile } from './attachments.media';

@Injectable()
export class AttachmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist an uploaded file for `ownerId`, optionally scoped to a session. Validates
   * size, and — when a sessionId is given — that the session belongs to the caller,
   * so an upload can't be parked on another tenant's session. Returns the new id.
   */
  async create(
    ownerId: string,
    sessionId: string | undefined,
    file: UploadedFile | undefined,
  ): Promise<{ id: string }> {
    assertValidUpload(file);
    const f = file as UploadedFile;
    if (sessionId) {
      const session = await this.prisma.session.findFirst({
        where: { id: sessionId, ownerId },
        select: { id: true },
      });
      if (!session) throw new NotFoundException('session not found');
    }
    const row = await this.prisma.attachment.create({
      data: {
        ownerId,
        sessionId: sessionId ?? null,
        mimeType: f.mimetype,
        sizeBytes: f.size,
        fileName: f.originalname || null,
        data: f.buffer,
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  /**
   * Fetch an attachment's bytes for `ownerId`. Filtering by ownerId in the query means a
   * non-owner gets a 404 (no existence leak) — that is the tenant-isolation guarantee.
   */
  async getForOwner(
    ownerId: string,
    id: string,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const row = await this.prisma.attachment.findFirst({
      where: { id, ownerId },
      select: { data: true, mimeType: true },
    });
    if (!row) throw new NotFoundException('attachment not found');
    return { data: Buffer.from(row.data), mimeType: row.mimeType };
  }
}
