// Whether this server has Drive (the drive, /drive, API /api/drive/*). The deployment
// switch ORBIT_DRIVE_ENABLED is read from `GET /auth/capabilities`, the query managed runners already
// use. A server from before the switch omits `documents`, and a failed or refused read says nothing:
// both read as on. Until the read has finished the answer is "not yet": entries stay out rather than
// flashing in and out, as the managed runner entry does.

import { useContext, useEffect, useState } from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import type { ServerCapabilities } from '@orbit/shared';
import { serverCapabilitiesQuery } from './managedRunner';

/**
 * `enabled`: draw the drive's entries and mount its routes (false until the read has finished).
 * `off`: the server said Drive is off; a drive link already in a transcript stays a card until then.
 * `settled`: the capability read has finished.
 */
export function useDriveEnabled(ask = true): { enabled: boolean; off: boolean; settled: boolean } {
  const capabilities = useQuery({ ...serverCapabilitiesQuery(), enabled: ask });
  const settled = capabilities.isFetched;
  const off = settled && capabilities.data?.documents?.enabled === false;
  return { settled, enabled: settled && !off, off };
}

/**
 * Whether the server has already said Drive is off, read from the capability cache without asking for it. For
 * what a transcript draws: a drive link stays a card until the server says off, and a transcript drawn outside any
 * QueryClient (a test, an embed) reads as on.
 */
export function useDriveSaidOff(): boolean {
  const client = useContext(QueryClientContext);
  const read = () => client?.getQueryData<Partial<ServerCapabilities> | null>(serverCapabilitiesQuery().queryKey)?.documents?.enabled === false;
  const [off, setOff] = useState(read);
  useEffect(() => {
    if (!client) return undefined;
    setOff(read());
    return client.getQueryCache().subscribe(() => setOff(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  return off;
}
