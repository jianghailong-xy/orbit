import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { WikiArticles } from './wiki-articles';
import { WikiRolloutGuard } from './wiki-rollout';

/**
 * The articles, on the user door (contracts/wiki.contract.json `articles.routes`): the owner reads a
 * space's category directory, one topic's article or one of its subtopic parts with the footnotes
 * resolved, and the A–Z index. Reads only — the door has no route that writes an article, which is
 * a maintenance run's work (`RunnerWikiArticlesController`).
 *
 * A controller of its own rather than more routes on `WikiController`, so the specs that stand that
 * one up by hand construct it exactly as before. Another account's space, topic or part is the plain
 * 404 every tenancy check answers.
 *
 * `article-index` is a path of its own, not `articles/index`: a topic's slug may be any word, `index`
 * among them.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiArticlesController {
  constructor(private readonly articles: WikiArticles) {}

  /** Categories in the contract's order, each with its topics and their articles. */
  @Get('spaces/:id/articles')
  directory(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.articles.directory(user.userId, id);
  }

  /** Every article of the space, A to Z by title. */
  @Get('spaces/:id/article-index')
  index(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.articles.index(user.userId, id);
  }

  /** A topic's article, or its overview. `slug` is the topic's, matched as text. */
  @Get('spaces/:id/articles/:slug')
  article(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Param('slug') slug: string) {
    return this.articles.article(user.userId, id, slug, 0);
  }

  /** One subtopic article of a split topic: `part` is its number, 1 or more. */
  @Get('spaces/:id/articles/:slug/:part')
  part(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('slug') slug: string,
    @Param('part', ParseIntPipe) part: number,
  ) {
    return this.articles.article(user.userId, id, slug, part);
  }
}
