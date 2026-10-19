import { Injectable } from '@nestjs/common';
import { WIKI_REPO_OP_CHANNEL } from './wiki-repo-ops';
import { WikiNotifyChannel } from './wiki-notify-channel';

/**
 * The repository operations' announcements (design §7): the channel `wiki-repo-ops.ts` NOTIFYs, from inside
 * the transaction that settles an operation, so a job that parked itself on one wakes as the answer lands
 * rather than on its poll. The connection, the retry and the poll fallback are `WikiNotifyChannel`'s.
 */
@Injectable()
export class WikiRepoOpChannel extends WikiNotifyChannel {
  constructor() {
    super(WIKI_REPO_OP_CHANNEL, 'WikiRepoOpChannel');
  }
}
