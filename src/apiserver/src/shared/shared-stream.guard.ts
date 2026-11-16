import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { toUuid } from '@orbit/shared';
import type { Request, Response } from 'express';
import { holdViewerStreamSlot, ViewerStreamCaps } from '../sessions/viewer-stream-caps';
import { linkNotFound } from '../share-links/share-link';
import { ShareLinksService } from '../share-links/share-links.service';
import { visitorAddress } from './public-surface.guard';

/** What SharedStreamGuard found the link opens, for the stream route to follow. */
export interface SharedStreamTarget {
  sessionId: string;
  toolOutput: boolean;
  /** The link's token and id, and whether it opened the session as a conversation besides its root: what the
   *  stream's access recheck reads again, and the revocation signals it answers to. */
  token: string;
  linkId: string;
  conversation: boolean;
}

/** Where SharedStreamGuard leaves its answer on the request. */
export const SHARED_STREAM_TARGET = 'sharedStreamTarget';

/**
 * The link's one 404 before a public stream runs (docs/session-viewer-stream-design.md §3): a stream's 200 is on the
 * wire before its handler has read anything, so a refusal made there would arrive as an `error` frame inside a 200.
 * Resolves the token first (ShareLinksService.resolve), then — on `:token/sessions/:sessionId/stream` — whether the
 * link opens that conversation, as the conversation's paged routes ask (openConversation); on `:token/stream`,
 * whether the link's root is a session. Runs after PublicSurfaceGuard, so a refused open spends the visitor's budget
 * like any other request. A `:sessionId` that is no id at all is the same 404. Last, the stream takes a slot of the
 * anonymous caps (§6: per visitor on this link, per link, per apiserver), or is refused 429 before anything is
 * subscribed; the slot is given back when the answer closes.
 */
@Injectable()
export class SharedStreamGuard implements CanActivate {
  constructor(
    private readonly links: ShareLinksService,
    private readonly caps: ViewerStreamCaps,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request<Record<string, string>> & { [SHARED_STREAM_TARGET]?: SharedStreamTarget }>();
    const link = await this.links.resolve(req.params?.token ?? '');
    let sessionId: string;
    if (req.params?.sessionId !== undefined) {
      try {
        sessionId = toUuid(req.params.sessionId);
      } catch {
        throw linkNotFound();
      }
      await this.links.openConversation(link, sessionId);
    } else {
      if (!link.sessionId) throw linkNotFound();
      sessionId = link.sessionId;
    }
    // The visitor as PublicSurfaceGuard budgets them: the address and the token.
    holdViewerStreamSlot(this.caps, http.getResponse<Response>(), {
      visitor: `${visitorAddress(req)} ${req.params?.token ?? ''}`,
      link: link.id,
    });
    req[SHARED_STREAM_TARGET] = {
      sessionId,
      toolOutput: link.include.toolOutput === true,
      token: req.params?.token ?? '',
      linkId: link.id,
      conversation: req.params?.sessionId !== undefined,
    };
    return true;
  }
}
