import { createContext } from 'react';
import { fetchAttachmentObjectUrl } from '../api';

/**
 * How a surface fetches an attachment's bytes (as an object URL). Defaults to the bearer-guarded
 * owner route; the public shared pages override it with the share-token route so a logged-out
 * viewer can still see inline images (see SharedSessionPage).
 *
 * Its own module rather than the transcript's: the coordinator question card draws the pictures a
 * question attaches, and the card is imported by the transcript's own rows (an answered question is
 * drawn where its turn was), so the card must not import the transcript back.
 */
export const AttachmentResolverContext =
  createContext<(id: string) => Promise<string>>((id) => fetchAttachmentObjectUrl(id));
