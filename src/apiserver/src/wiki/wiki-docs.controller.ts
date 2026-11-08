import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { WikiDocs } from './wiki-docs';
import { WikiRolloutGuard } from './wiki-rollout';
import { actingSession } from './wiki.controller';

type Headers = { headers: Record<string, string | string[] | undefined> };

/**
 * The documents, on the user door (contracts/wiki.contract.json `docs.routes`): the owner reads the
 * confirmed plan's directory of documents, one document with its sentences' statuses and its footnotes
 * resolved, and the A–Z index; and the versions a section kept (`docs.versions`): a section's versions,
 * each compared sentence by sentence with what replaced it, and Activity's Docs rows. The door has one
 * route that writes a document — the owner's restore of a version a section kept — which brings back what
 * the server's own jobs wrote (its `docs_build` and `maintain` jobs, and an import its container runs:
 * `WikiDocs.write`) and writes none of its own.
 *
 * A controller of its own rather than more routes on `WikiController`, so the specs that stand that one
 * up by hand construct it exactly as before. Another account's space, document or version is the plain
 * 404 every tenancy check answers. `doc-index` is a path of its own, not `docs/index`: a document's slug
 * may be any word, `index` among them. The restore is the owner's own: a personal access token is refused
 * OWNER_INTERACTIVE_CREDENTIAL_REQUIRED, and a request carrying a session header WIKI_OWNER_CHANNEL_ONLY
 * before anything is read.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiDocsController {
  constructor(private readonly docs: WikiDocs) {}

  /** The confirmed plan's categories, each with its documents and their sections, as written so far. */
  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('spaces/:id/docs')
  directory(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.docs.directory(user.userId, id);
  }

  /** Every document of the plan, and every section title no other document shares, A to Z. */
  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('spaces/:id/doc-index')
  index(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.docs.index(user.userId, id);
  }

  /** One document: `slug` is the plan document's, matched as text. */
  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('spaces/:id/docs/:slug')
  doc(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Param('slug') slug: string) {
    return this.docs.doc(user.userId, id, slug);
  }

  /** One section's versions, newest first: `slug` and `key` are the plan document's and section's, matched as text. */
  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('spaces/:id/docs/:slug/sections/:key/versions')
  versions(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Param('slug') slug: string, @Param('key') key: string) {
    return this.docs.sectionVersions(user.userId, id, slug, key);
  }

  /** Activity's Docs rows: the space's sections written again, newest first. */
  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('spaces/:id/doc-changes')
  changes(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.docs.docChanges(user.userId, id);
  }

  /** Put a section back as one of its versions kept it. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('doc-versions/:id/restore')
  @HttpCode(HttpStatus.OK)
  restore(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Req() request: Headers) {
    return this.docs.restore(user.userId, id, actingSession(request.headers));
  }
}
