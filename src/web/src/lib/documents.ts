// Whether this server has Documents (the Orbit Files drive, /files, API /api/drive/*). The deployment
// switch ORBIT_DOCUMENTS_ENABLED is read from `GET /auth/capabilities`, the query managed runners already
// use. A server from before the switch omits `documents`, and a failed or refused read says nothing:
// both read as on. Until the read has finished the answer is "not yet": entries stay out rather than
// flashing in and out, as the managed runner entry does.

import { useQuery } from '@tanstack/react-query';
import { serverCapabilitiesQuery } from './managedRunner';

/**
 * `enabled`: draw the drive's entries and mount its routes (false until the read has finished).
 * `off`: the server said Documents is off; a drive link already in a transcript stays a card until then.
 * `settled`: the capability read has finished.
 */
export function useDocumentsEnabled(ask = true): { enabled: boolean; off: boolean; settled: boolean } {
  const capabilities = useQuery({ ...serverCapabilitiesQuery(), enabled: ask });
  const settled = capabilities.isFetched;
  const off = settled && capabilities.data?.documents?.enabled === false;
  return { settled, enabled: settled && !off, off };
}
