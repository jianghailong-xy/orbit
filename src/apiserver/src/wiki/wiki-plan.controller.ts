import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { WikiPlans } from './wiki-plan';
import { WikiRolloutGuard } from './wiki-rollout';
import { actingSession } from './wiki.controller';

type Headers = { headers: Record<string, string | string[] | undefined> };

/**
 * The plan, on the user door (contracts/wiki.contract.json `plan.routes`): the owner reads the plan in
 * force, its draft, its history and the changes proposed to it; edits a document or a section into a
 * new draft; confirms the draft; and accepts or rejects a proposal.
 *
 * And the owner asks for a draft, or a revision with their instructions (`redraft`): a job of the plan
 * the server runs as a task of the space's maintenance list (contract `plan.jobs`).
 *
 * THE OWNER CHANNEL, EVERY ROUTE. A request carrying a session header is refused
 * WIKI_OWNER_CHANNEL_ONLY before anything is read, whatever the session's role — the plan is what every
 * document is written from, and a session reporting a person's answer is not a person answering. The
 * runner door has no route that confirms or decides anything (`RunnerWikiPlanController`).
 *
 * A controller of its own rather than more routes on `WikiController`, so the specs that stand that one
 * up by hand construct it exactly as before. Another account's space, version or proposal is the plain
 * 404 every tenancy check answers. `plan/versions` is declared before `plan/versions/:version`.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiPlanController {
  constructor(private readonly plans: WikiPlans) {}

  /** The version in force, the draft waiting for the owner, and the pending proposals. */
  @Get('spaces/:id/plan')
  state(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Req() request: Headers) {
    return this.plans.state(user.userId, id, actingSession(request.headers));
  }

  /** Every version, newest first. */
  @Get('spaces/:id/plan/versions')
  versions(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Req() request: Headers) {
    return this.plans.versions(user.userId, id, actingSession(request.headers));
  }

  /** One version, whole. `version` is its number, 1 or more. */
  @Get('spaces/:id/plan/versions/:version')
  version(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() request: Headers,
  ) {
    return this.plans.version(user.userId, id, version, actingSession(request.headers));
  }

  /** One document, or one section of one, as the owner rewrote it: a new draft. */
  @Post('spaces/:id/plan/edits')
  @HttpCode(HttpStatus.OK)
  edit(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() body: Record<string, unknown>, @Req() request: Headers) {
    return this.plans.edit(user.userId, id, body, actingSession(request.headers));
  }

  /** The owner's confirmation of the space's draft: from then on, the documents are written from it. */
  @Post('spaces/:id/plan/versions/:version/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() request: Headers,
  ) {
    return this.plans.confirm(user.userId, id, version, actingSession(request.headers));
  }

  /**
   * Ask for a draft of the plan — with `instructions`, a revision of its newest version (contract
   * `plan.routes.redraft`): made as a task of the space's maintenance list, queued behind its unfinished
   * task, or held with why. The space's draft that has not ended answers a second request.
   */
  @Post('spaces/:id/plan/redraft')
  @HttpCode(HttpStatus.OK)
  redraft(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() body: Record<string, unknown>, @Req() request: Headers) {
    return this.plans.redraft(user.userId, id, body, actingSession(request.headers));
  }

  /** Accept a proposal, which makes a new draft, or reject it, which changes nothing but the proposal. */
  @Post('plan-proposals/:id/decide')
  @HttpCode(HttpStatus.OK)
  decide(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() body: Record<string, unknown>, @Req() request: Headers) {
    return this.plans.decide(user.userId, id, body, actingSession(request.headers));
  }
}
