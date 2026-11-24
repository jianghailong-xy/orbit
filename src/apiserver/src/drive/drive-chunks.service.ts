import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Readable } from 'node:stream';
import { removeTempFile, TempFileTooLargeError, uploadTempDir, writeHashedTempFile } from '../files/file-store';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The most one drive chunk holds (docs/drive-technical-design.md §2.2): small enough to be one temporary file,
 * one file_blob and one signed S3 PUT, and to read whole when serving part of it.
 */
export const DRIVE_CHUNK_MAX = 8 * 1024 * 1024;

/** Who opened a staging (drive_staging_source_chk). */
export type DriveStagingSource = 'OWNER_UPLOAD' | 'MOUNT' | 'TOOL';

export const DRIVE_STAGING_NOT_FOUND = 'DRIVE_STAGING_NOT_FOUND';
export const DRIVE_CHUNK_TOO_LARGE = 'DRIVE_CHUNK_TOO_LARGE';
export const DRIVE_CHUNK_EMPTY = 'DRIVE_CHUNK_EMPTY';
export const DRIVE_CHUNK_SHA256_MISMATCH = 'DRIVE_CHUNK_SHA256_MISMATCH';
export const DRIVE_CHUNK_INVALID = 'DRIVE_CHUNK_INVALID';

const SHA256_HEX = /^[0-9a-f]{64}$/;

function refusal(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

/**
 * The streaming chunk door of the drive (§2.2): a write of any size arrives as chunks of at most 8 MiB, and each is kept
 * the way an attachment's bytes are, through `FilesService.store`, then held by its staging row until a commit names it.
 * At most one chunk per request is ever in the files directory's `tmp/`, so no file exists whole on the server's disk.
 * The routes that call this (owner uploads, the runner drive door) belong to their own tasks and take the owner from the
 * credential.
 */
@Injectable()
export class DriveChunksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  /** A new staging of `ownerId`'s, with nothing in it yet. */
  async openStaging(
    ownerId: string,
    staging: {
      source: DriveStagingSource;
      entryId?: string | null;
      runnerId?: string | null;
      generation?: number | null;
      parentId?: string | null;
      name?: string | null;
      relativePath?: string | null;
      declaredSize?: number | null;
    },
  ): Promise<{ id: string }> {
    return this.prisma.driveStaging.create({
      data: {
        ownerId,
        source: staging.source,
        entryId: staging.entryId ?? null,
        runnerId: staging.runnerId ?? null,
        generation: staging.generation ?? null,
        parentId: staging.parentId ?? null,
        name: staging.name ?? null,
        relativePath: staging.relativePath ?? null,
        declaredSize: staging.declaredSize ?? null,
      },
      select: { id: true },
    });
  }

  /**
   * Keep chunk `idx` of `ownerId`'s staging `stagingId`: `body`, at most DRIVE_CHUNK_MAX bytes whose sha256 the client
   * declared as `sha256`. The body goes to one temporary file while it is hashed, is refused if it is longer than a chunk
   * or hashes to something else, and is otherwise kept by `store()`, which stamps the blob before anything else so the
   * retention sweep leaves it until the staging chunk row written next names it. A chunk re-sent for the same `idx`
   * replaces the row: the call is idempotent. Another account's staging, or one already committed, is not found.
   */
  async putChunk(
    ownerId: string,
    stagingId: string,
    idx: number,
    sha256: string,
    body: Readable,
  ): Promise<{ sha256: string; sizeBytes: number }> {
    if (!Number.isSafeInteger(idx) || idx < 0 || idx > 0x7fffffff) {
      body.resume();
      throw refusal(HttpStatus.BAD_REQUEST, DRIVE_CHUNK_INVALID, `A chunk index is a whole number from 0, not ${idx}.`);
    }
    if (!SHA256_HEX.test(sha256)) {
      body.resume();
      throw refusal(HttpStatus.BAD_REQUEST, DRIVE_CHUNK_INVALID, 'A chunk names its sha256 as 64 lowercase hex characters.');
    }
    const staging = await this.prisma.driveStaging.findFirst({
      where: { id: stagingId, ownerId, committedAt: null },
      select: { id: true },
    });
    if (!staging) {
      body.resume();
      throw stagingNotFound();
    }
    let temp;
    try {
      temp = await writeHashedTempFile(body, uploadTempDir(this.files.config.dir), undefined, DRIVE_CHUNK_MAX);
    } catch (error) {
      if (error instanceof TempFileTooLargeError) {
        body.resume();
        throw refusal(HttpStatus.PAYLOAD_TOO_LARGE, DRIVE_CHUNK_TOO_LARGE, `A chunk is at most ${DRIVE_CHUNK_MAX} bytes.`);
      }
      throw error;
    }
    try {
      if (temp.size === 0) throw refusal(HttpStatus.BAD_REQUEST, DRIVE_CHUNK_EMPTY, 'A chunk holds at least one byte.');
      if (temp.sha256 !== sha256) {
        throw refusal(
          HttpStatus.BAD_REQUEST,
          DRIVE_CHUNK_SHA256_MISMATCH,
          `The chunk arrived with the sha256 ${temp.sha256}, not the ${sha256} it was sent with, so it was not kept.`,
        );
      }
      await this.files.store(temp);
    } finally {
      await removeTempFile(temp.path);
    }
    try {
      await this.prisma.driveStagingChunk.upsert({
        where: { stagingId_idx: { stagingId, idx } },
        create: { stagingId, idx, ownerId, sha256, sizeBytes: temp.size },
        update: { sha256, sizeBytes: temp.size },
      });
      await this.prisma.driveStaging.update({ where: { id: stagingId }, data: { touchedAt: new Date() } });
    } catch (error) {
      // The staging went (abandoned, or removed by the sweep) while the chunk was arriving.
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2003' || error.code === 'P2025')) {
        throw stagingNotFound();
      }
      throw error;
    }
    return { sha256, sizeBytes: temp.size };
  }
}

function stagingNotFound(): HttpException {
  return refusal(HttpStatus.NOT_FOUND, DRIVE_STAGING_NOT_FOUND, 'No such upload in progress.');
}
