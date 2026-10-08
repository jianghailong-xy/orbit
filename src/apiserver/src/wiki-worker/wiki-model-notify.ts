import { Injectable } from '@nestjs/common';
import { WIKI_MODEL_REQUEST_CHANNEL } from './wiki-model-queue';
import { WikiNotifyChannel } from './wiki-notify-channel';

/**
 * The model request queue's announcements (design §5.5): the channel `wiki-model-queue.service.ts` NOTIFYs
 * when a request settles, listened to by the worker whose job is waiting on it. The connection, the retry
 * and the poll fallback are `WikiNotifyChannel`'s; this names the channel.
 */
@Injectable()
export class WikiModelRequestChannel extends WikiNotifyChannel {
  constructor() {
    super(WIKI_MODEL_REQUEST_CHANNEL, 'WikiModelChannel');
  }
}
