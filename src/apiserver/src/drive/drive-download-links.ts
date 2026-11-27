import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DriveContentService, type DriveContent } from './drive-content.service';
import { DRIVE_ENTRY_NOT_FOUND, DRIVE_NOT_A_FILE, DRIVE_VERSION_NOT_FOUND } from './drive.service';

/** How long a minted download URL opens its file: long enough for the browser to start, short enough to leak little. */
export const DRIVE_DOWNLOAD_LINK_TTL_SECONDS = 5 * 60;
/** The one answer every URL that opens nothing gets: forged, expired, or naming a version that is gone. */
export const DRIVE_DOWNLOAD_LINK_NOT_FOUND = 'DRIVE_DOWNLOAD_LINK_NOT_FOUND';
/** The signing domain: a key of its own derived from JWT_SECRET, so a login never verifies as one of these, nor one of
 *  these as a login. */
const KEY_DERIVATION_DOMAIN = 'orbit-drive-download-link-v1';
const KIND = 'drive-dl';

interface Claims {
  sub: string;
  e: string;
  v: string;
  k: string;
}

const gone = () =>
  new HttpException(
    { code: DRIVE_DOWNLOAD_LINK_NOT_FOUND, message: 'This download link has expired or opens nothing. Download the file again from Files.' },
    HttpStatus.NOT_FOUND,
  );

/**
 * A file's download as the browser's own download (docs/drive-technical-design.md §4.1, D12): the content
 * route takes a bearer header, which a navigation cannot send, so the Files page first asks for a short-lived URL bound
 * to the owner, the file and one version, and navigates to it. The browser then streams the bytes to disk with its
 * download manager, whatever their size, and a Range resumes it.
 *
 * Stateless: the URL's token is signed and says what it opens and until when; nothing is written to mint or open one.
 */
@Injectable()
export class DriveDownloadLinks {
  private readonly jwt: JwtService;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly content: DriveContentService,
  ) {
    const rootSecret = config.get<string>('JWT_SECRET');
    if (!rootSecret) throw new Error('JWT_SECRET is required');
    this.jwt = new JwtService({ secret: createHmac('sha256', rootSecret).update(KEY_DERIVATION_DOMAIN).digest() });
  }

  /** Mint a URL for `entryId`'s current version, or `versionId` of it: a live file of the owner's. */
  async mint(ownerId: string, entryId: string, versionId?: string): Promise<{ path: string; expiresAt: string }> {
    const entry = await this.prisma.driveEntry.findFirst({ where: { id: entryId, ownerId, trashedAt: null } });
    if (!entry) throw new HttpException({ code: DRIVE_ENTRY_NOT_FOUND, message: 'No such file or folder.' }, HttpStatus.NOT_FOUND);
    if (entry.kind !== 'FILE' || !entry.currentVersionId) {
      throw new HttpException({ code: DRIVE_NOT_A_FILE, message: 'A folder has no content to download.' }, HttpStatus.CONFLICT);
    }
    let version = entry.currentVersionId;
    if (versionId) {
      const found = await this.prisma.driveVersion.findFirst({ where: { id: versionId, ownerId, entryId }, select: { id: true } });
      if (!found) throw new HttpException({ code: DRIVE_VERSION_NOT_FOUND, message: 'No such version.' }, HttpStatus.NOT_FOUND);
      version = found.id;
    }
    const claims: Claims = { sub: ownerId, e: entryId, v: version, k: KIND };
    const token = await this.jwt.signAsync(claims, { expiresIn: DRIVE_DOWNLOAD_LINK_TTL_SECONDS });
    return {
      path: `/api/drive/dl/${token}`,
      expiresAt: new Date(Date.now() + DRIVE_DOWNLOAD_LINK_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** What a URL opens: the version it was minted for, while it has not expired and still belongs to that file. */
  async open(token: string, request: { range?: string; ifRange?: string; ifNoneMatch?: string }): Promise<DriveContent> {
    let claims: Claims;
    try {
      claims = await this.jwt.verifyAsync<Claims>(token);
    } catch {
      throw gone();
    }
    if (claims.k !== KIND || !claims.sub || !claims.e || !claims.v) throw gone();
    const version = await this.prisma.driveVersion.findFirst({
      where: { id: claims.v, ownerId: claims.sub, entryId: claims.e },
      select: { id: true },
    });
    if (!version) throw gone();
    return this.content.ofVersion(claims.sub, version.id, request);
  }
}
