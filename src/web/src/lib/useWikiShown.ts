import { useQuery } from '@tanstack/react-query';
import { wikiSpacesQuery } from './queries';
import { wikiShown } from './wiki';

/**
 * Whether this account is offered the wiki at all (`wikiShown`): read from the owner's spaces, the one
 * query the sidebar's count already keeps, so asking costs no request of its own.
 */
export function useWikiShown(): boolean {
  return wikiShown(useQuery(wikiSpacesQuery()));
}
