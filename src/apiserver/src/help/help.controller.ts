import {
  BadRequestException,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  DEFAULT_HELP_LANGUAGE,
  isHelpLanguage,
  type HelpArticle,
  type HelpIndex,
  type HelpLanguage,
  type HelpSearchResult,
} from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { HelpLibrary } from './help-library';

/**
 * The help doors are open to everyone (board 03: an article reads signed out, so the sign-in page's "Can't sign
 * in?" can link straight to one). A request with no Authorization header is a signed-out reader; one that carries
 * a credential is judged by JwtAuthGuard, as everywhere else — so an expired login is a 401 its client refreshes
 * on, rather than an administrator silently shown a member's help — and only to learn who is reading.
 */
@Injectable()
export class HelpReaderGuard implements CanActivate {
  constructor(private readonly jwt: JwtAuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (!req.headers['authorization']) return true;
    return this.jwt.canActivate(context);
  }
}

/**
 * GET /api/help, /api/help/articles/:slug and /api/help/search?q= (design: docs/mocks/help-center board 03): the
 * article library this server shipped with. Admin & self-hosting is shown to administrators only; to anyone else
 * its articles are not in the index or search, and reading one is the 404 of an article that does not exist.
 */
@Controller('help')
@UseGuards(HelpReaderGuard)
export class HelpController {
  constructor(
    private readonly library: HelpLibrary,
    private readonly prisma: PrismaService,
  ) {}

  /** Whether the reader is an administrator, read per request as AdminRoleGuard does. Signed out is not. */
  private async admin(req: { user?: AuthUser }): Promise<boolean> {
    const userId = req.user?.userId;
    if (!userId) return false;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role === 'ADMIN';
  }

  /** `?lang=<HELP_LANGUAGES code>`: the language the reader asked for; absent is English. */
  private language(raw: unknown): HelpLanguage {
    if (raw === undefined) return DEFAULT_HELP_LANGUAGE;
    if (!isHelpLanguage(raw)) throw new BadRequestException(`unknown help language: ${String(raw)}`);
    return raw;
  }

  @Get()
  async index(@Req() req: { user?: AuthUser }, @Query('lang') lang: unknown): Promise<HelpIndex> {
    return this.library.index(await this.admin(req), this.language(lang));
  }

  @Get('articles/:slug')
  async article(
    @Req() req: { user?: AuthUser },
    @Param('slug') slug: string,
    @Query('lang') lang: unknown,
  ): Promise<HelpArticle> {
    const article = this.library.article(slug, await this.admin(req), this.language(lang));
    if (!article) throw new NotFoundException('no such help article');
    return article;
  }

  @Get('search')
  async search(
    @Req() req: { user?: AuthUser },
    @Query('q') q: unknown,
    @Query('lang') lang: unknown,
  ): Promise<HelpSearchResult> {
    return this.library.search(typeof q === 'string' ? q : '', await this.admin(req), this.language(lang));
  }
}
