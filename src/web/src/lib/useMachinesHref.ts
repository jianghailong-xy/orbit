import { useQuery } from '@tanstack/react-query';
import { encodeId } from './idCodec';
import { runnersQuery } from './queries';

/** Where a link to "the machines" goes now that they are Settings pages: the first machine's page, or
 *  General when there is none — what /infrastructure resolves to. */
export function useMachinesHref(): string {
  const first = ((useQuery(runnersQuery()).data ?? []) as Array<{ id: string }>)[0];
  return first ? `/settings/machines/${encodeId(first.id)}` : '/settings/general';
}
