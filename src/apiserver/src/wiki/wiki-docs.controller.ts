import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { WikiDocs } from './wiki-docs';
import { WikiRolloutGuard } from './wiki-rollout';

/**
 * The documents, on the user door (contracts/wiki.contract.json `docs.routes`): the owner reads the
 * confirmed plan's directory of documents, one document with its sentences' statuses and its footnotes
 * resolved, and the A–Z index. Reads only — the door has no route that writes a document, which is a
 * maintenance run's work (`RunnerWikiDocsController`).
 *
 * A controller of its own rather than more routes on `WikiController`, so the specs that stand that one
 * up by hand construct it exactly as before. Another account's space or document is the plain 404 every
 * tenancy check answers. `doc-index` is a path of its own, not `docs/index`: a document's slug may be any
 * word, `index` among them.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiDocsController {
  constructor(private readonly docs: WikiDocs) {}

  /** The confirmed plan's categories, each with its documents and their sections, as written so far. */
  @Get('spaces/:id/docs')
  directory(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.docs.directory(user.userId, id);
  }

  /** Every document of the plan, and every section title no other document shares, A to Z. */
  @Get('spaces/:id/doc-index')
  index(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.docs.index(user.userId, id);
  }

  /** One document: `slug` is the plan document's, matched as text. */
  @Get('spaces/:id/docs/:slug')
  doc(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Param('slug') slug: string) {
    return this.docs.doc(user.userId, id, slug);
  }
}
