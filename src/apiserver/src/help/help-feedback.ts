import { Body, Controller, Get, HttpCode, Injectable, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { HELP_FEEDBACK_KINDS, type HelpFeedbackKind, type HelpFeedbackSummary } from '@orbit/shared';
import { IsBoolean, IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { HelpLibrary } from './help-library';

/** An Ask answer's id: the Ask's session id and the answer's turn seq, `<session>:<seq>`. */
const ANSWER_ID = /^[A-Za-z0-9_-]{1,64}:\d{1,12}$/u;

/**
 * POST /api/help/feedback's body. These three fields are all a vote is: the global ValidationPipe's whitelist drops
 * anything else a client sends, and the table has no column it could go in (migration 0900).
 */
export class HelpFeedbackDto {
  @IsIn(HELP_FEEDBACK_KINDS)
  kind!: HelpFeedbackKind;

  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_:-]+$/u)
  id!: string;

  @IsBoolean()
  helpful!: boolean;
}

/**
 * Did this help? / Did this answer it? (docs/mocks/help-center board 03, decision 3): a person's Yes / No on an
 * article or an Ask answer, one per person per item, the last one standing; and, for administrators, the counts —
 * per article, and the Ask answers' totals. No text is taken, and no question or answer is shown.
 */
@Injectable()
export class HelpFeedback {
  constructor(
    private readonly prisma: PrismaService,
    private readonly library: HelpLibrary,
  ) {}

  /** Record `userId`'s vote; a second vote on the same item replaces the first, and its time with it. */
  async record(userId: string, body: HelpFeedbackDto): Promise<void> {
    if (body.kind === 'article' ? !this.library.article(body.id, true) : !ANSWER_ID.test(body.id)) {
      throw new NotFoundException(body.kind === 'article' ? 'no such help article' : 'no such Ask answer');
    }
    const at = new Date();
    await this.prisma.helpFeedback.upsert({
      where: { userId_kind_itemId: { userId, kind: body.kind, itemId: body.id } },
      create: { userId, kind: body.kind, itemId: body.id, helpful: body.helpful, createdAt: at },
      update: { helpful: body.helpful, createdAt: at },
    });
  }

  /** Every voted article's Yes / No, most No first, and the Ask answers' Yes / No summed over every answer. */
  async summary(): Promise<HelpFeedbackSummary> {
    const groups = await this.prisma.helpFeedback.groupBy({ by: ['kind', 'itemId', 'helpful'], _count: { _all: true } });
    const articles = new Map<string, { yes: number; no: number }>();
    const answers = { yes: 0, no: 0 };
    for (const g of groups) {
      const counts = g.kind === 'answer' ? answers : (articles.get(g.itemId) ?? articles.set(g.itemId, { yes: 0, no: 0 }).get(g.itemId)!);
      counts[g.helpful ? 'yes' : 'no'] += g._count._all;
    }
    return {
      articles: [...articles]
        .map(([slug, counts]) => {
          const article = this.library.article(slug, true);
          return { slug, title: article?.title ?? null, category: article?.category ?? null, ...counts };
        })
        .sort((a, b) => b.no - a.no || b.yes - a.yes || a.slug.localeCompare(b.slug)),
      answers,
    };
  }
}

/** POST /api/help/feedback: the signed-in person's Yes / No. Signed out, there is no one to count once. */
@Controller('help/feedback')
@UseGuards(JwtAuthGuard)
export class HelpFeedbackController {
  constructor(private readonly feedback: HelpFeedback) {}

  @PatForbidden('NO_SCOPE')
  @Post()
  @HttpCode(204)
  record(@CurrentUser() user: AuthUser, @Body() body: HelpFeedbackDto): Promise<void> {
    return this.feedback.record(user.userId, body);
  }
}

/** GET /api/admin/help-feedback: Admin → Help feedback's counts, to administrators only (403 to anyone else). */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin/help-feedback')
export class AdminHelpFeedbackController {
  constructor(private readonly feedback: HelpFeedback) {}

  @Get()
  summary(): Promise<HelpFeedbackSummary> {
    return this.feedback.summary();
  }
}
