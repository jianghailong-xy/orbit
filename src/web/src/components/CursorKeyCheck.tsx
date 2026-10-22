import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CursorKeyRecheckAnswer } from '@orbit/shared';
import { api } from '../api';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { ago } from '../lib/runnerEngines';
import { useToast } from '../lib/toast';
import { useNow } from './WatchParts';
import './DeepSeekBalance.css';

/**
 * A Cursor key's line on Infrastructure's API keys: what Cursor answered the last time one of the
 * owner's runners checked the key it holds now (`keyCheckState`, `agent models` — the board's Web 4 ④).
 * Refused, the way on is a new key; Cursor out of the runner's reach says nothing about the key, and is
 * asked again (Check Again). A key Cursor accepted, or none has checked yet, says nothing.
 */
export function CursorKeyCheckLine({ row }: { row: ProviderRow }) {
  const qc = useQueryClient();
  const message = useToast();
  const now = useNow(30_000);
  const recheck = useMutation({
    mutationFn: () => api<CursorKeyRecheckAnswer>(`${PROVIDERS_BASE}/${row.id}/key-check`, { method: 'POST' }),
    onSuccess: (answer) => {
      void qc.invalidateQueries({ queryKey: PROVIDERS_LIST_KEY });
      // An answer kept on the key changes this line; one that could not be had says why here.
      if (!answer.recorded) message.error("Couldn't check the key", answer.message);
    },
    onError: (e: Error) => message.error("Couldn't check the key", e.message),
  });
  const when = row.keyCheckedAt ? ` · ${ago(row.keyCheckedAt, now)}` : '';
  if (row.keyCheckState === 'INVALID') {
    return (
      <div className="prov-runtime dsb-row">
        <div className="dsb-line fail">
          Rejected by Cursor{when} <span className="dsb-sep">·</span>{' '}
          <Link className="re-link" to={`/providers/${row.id}`}>
            Paste a new key
          </Link>
        </div>
      </div>
    );
  }
  if (row.keyCheckState === 'UNREACHABLE') {
    return (
      <div className="prov-runtime dsb-row">
        <div className="dsb-line fail">
          Couldn’t reach Cursor to check this key{when} <span className="dsb-sep">·</span>{' '}
          <button type="button" className="re-link" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
            {recheck.isPending ? 'Checking…' : 'Retry'}
          </button>
        </div>
      </div>
    );
  }
  return null;
}
