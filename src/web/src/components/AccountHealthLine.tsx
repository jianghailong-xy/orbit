import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountHealthQuery, ACCOUNT_HEALTH_QUERY_KEY, checkAgain, runnerAccountBlock, type AccountHealthBlock } from '../lib/accountHealth';
import { pauseResumeTime } from '../lib/accountPause';
import { useToast } from '../lib/toast';
import { Button } from './ui/Button';

/** Engine names as the row says them: "Cursor said …" (the same words the push uses). */
const PRODUCT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', antigravity: 'Antigravity', cursor: 'Cursor' };

/** `Nov 22, 17:19`: when the streak began. */
function sinceLabel(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

/**
 * The account row's line for a blocked account (docs/routing-account-health-design.md §8 item 2): a classified refusal reads
 * `Needs action · Cursor said "Add a payment method to continue" · since Nov 22, 17:19 · tried again at 21:19`; the
 * breaker's guess reads `Not used for now · failed to start 2 runs · since … · tried again at …`. Check again says the
 * account is fixed: the block is cleared and the next run uses it.
 */
export function AccountHealthBlockLine({ block, now = Date.now() }: { block: AccountHealthBlock; now?: number }) {
  const qc = useQueryClient();
  const message = useToast();
  const classified = block.kind !== 'UNCLASSIFIED_ADMISSION';
  const product = (block.engine && PRODUCT[block.engine]) || 'The provider';
  const check = useMutation({
    mutationFn: () => checkAgain(block.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ACCOUNT_HEALTH_QUERY_KEY });
      message.success('Checking again: Orbit will use this account for the next run');
    },
    onError: (error: Error) => { message.error("Couldn't check again", error.message); },
  });
  // The server's own sentence says whose words they are for a key or pool login, which have no engine of their own.
  const lead = block.line ? block.line : classified
    ? (block.said ? `Needs action · ${product} said "${block.said}"` : `Needs action · ${product} refused this account`)
    : `Not used for now · failed to start ${block.trips + 1} runs`;
  const next = block.trialRunning
    ? 'trying it now'
    : block.nextTrialAt ? `tried again at ${pauseResumeTime(block.nextTrialAt, now)}` : null;
  return (
    <div className="re-health" role="status">
      <span className={`re-health-text${classified ? ' needs-action' : ''}`}>
        {[lead, `since ${sinceLabel(block.since)}`, next].filter(Boolean).join(' · ')}
      </span>
      <Button size="small" className="re-health-check" loading={check.isPending} onClick={() => check.mutate()}>Check again</Button>
    </div>
  );
}

/** The line for one runner sign-in, drawn only while it is blocked. */
export function AccountHealthLine({ runnerId, engine, account }: { runnerId: string; engine: string; account: string }) {
  const { data } = useQuery(accountHealthQuery);
  const block = runnerAccountBlock(data?.blocks, runnerId, engine, account);
  return block ? <AccountHealthBlockLine block={block} /> : null;
}


/** The line for a key (or a Claude pool member, which is a key): `provider:<id>`, drawn only while it is blocked. */
export function AccountHealthProviderLine({ providerId }: { providerId: string }) {
  const { data } = useQuery(accountHealthQuery);
  const block = data?.blocks?.find((b) => b.providerId === providerId && b.scopeModel === '');
  return block ? <AccountHealthBlockLine block={block} /> : null;
}

/** The line for a Codex pool login: `pool-login:<pool>:<account>`. */
export function AccountHealthLoginLine({ poolId, accountId }: { poolId: string; accountId: string }) {
  const { data } = useQuery(accountHealthQuery);
  const block = data?.blocks?.find((b) => b.poolId === poolId && b.account === accountId && b.scopeModel === '');
  return block ? <AccountHealthBlockLine block={block} /> : null;
}
