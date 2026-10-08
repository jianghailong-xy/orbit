import type { ReactNode } from 'react';
import { ExclamationCircleFilled, ExportOutlined, ReloadOutlined, WarningFilled } from '@ant-design/icons';
import { Button } from 'antd';
import type { ProviderBalanceAmount } from '@orbit/shared';
import {
  balanceAgo,
  balanceSplit,
  balanceView,
  DEEPSEEK_TOP_UP_URL,
  formatBalance,
  useDeepSeekBalance,
  type BalanceView,
} from '../lib/deepseekBalance';
import type { ProviderRow } from '../lib/providerAdmin';
import { useToast } from '../lib/toast';
import { useNow } from './WatchParts';
import './DeepSeekBalance.css';

// The DeepSeek account balance behind a DeepSeek key, on the Providers list (one line under the row)
// and on the key's edit page (a section under the key). Every amount on screen is DeepSeek's own
// answer; while there is none it says so — loading, or why it failed — and never draws a 0.

const NOTE =
  'The balance of the whole DeepSeek account this key belongs to — every app and person using that account draws on it, so it is not what Orbit or this session spent. Granted credit is spent before topped-up credit.';
const MULTI_CURRENCY = "Each currency is a separate balance; DeepSeek doesn't convert between them.";

function useBalance(row: ProviderRow) {
  const message = useToast();
  const { query, refresh } = useDeepSeekBalance(row.id);
  const view = balanceView(query.data, query.error);
  const ask = () => {
    if (refresh.isPending) return;
    refresh.mutate(undefined, {
      onError: (e: Error) => message.error("Couldn't refresh the balance", e.message),
    });
  };
  return { view, ask, asking: refresh.isPending };
}

/** The row's line on the Providers list: the total, or why there isn't one. */
export function DeepSeekBalanceLine({ row }: { row: ProviderRow }) {
  const { view, ask, asking } = useBalance(row);
  const now = useNow(30_000);
  return (
    <div className="prov-runtime dsb-row" data-testid="deepseek-balance-line">
      <BalanceLine view={view} ask={ask} asking={asking} now={now} />
    </div>
  );
}

function BalanceLine({ view, ask, asking, now }: { view: BalanceView; ask: () => void; asking: boolean; now: number }) {
  if (view.kind === 'loading') return <div className="dsb-line">Checking account balance…</div>;
  if (view.kind === 'failed') {
    return (
      <div className="dsb-line fail" title={view.message}>
        Balance unavailable: {view.label} <span className="dsb-sep">·</span>{' '}
        <button type="button" className="re-link" disabled={asking} onClick={ask}>
          Retry
        </button>
      </div>
    );
  }
  const { balances, isAvailable, fetchedAt } = view.balance;
  // The spaces between the parts are for whoever copies or reads the line aloud; the flex gap draws them.
  const amounts = balances.map((b, i) => (
    <span key={b.currency} className="dsb-amounts">
      {i > 0 && <>{' '}<span className="dsb-sep">·</span>{' '}</>}
      <b>{formatBalance(b.totalBalance, b.currency)}</b>
    </span>
  ));
  if (!isAvailable) {
    return (
      <>
        <div className="dsb-line low">
          Balance {amounts} — too low, DeepSeek calls will fail
        </div>
        <div className="dsb-line">
          <a className="re-link" href={DEEPSEEK_TOP_UP_URL} target="_blank" rel="noreferrer">
            Top up on DeepSeek ↗
          </a>
        </div>
      </>
    );
  }
  const updated = (
    <>
      updated {balanceAgo(fetchedAt, now)}{' '}
      <button type="button" className="re-link" title="Refresh" aria-label="Refresh the balance" disabled={asking} onClick={ask}>
        <ReloadOutlined spin={asking} />
      </button>
    </>
  );
  // One currency fits on one line; a second one takes the room the time had.
  return balances.length === 1 ? (
    <div className="dsb-line">
      Account balance {amounts} <span className="dsb-sep">·</span> {updated}
    </div>
  ) : (
    <>
      <div className="dsb-line">Account balance {amounts}</div>
      <div className="dsb-line">{updated}</div>
    </>
  );
}

/** The edit page's section, right under the key it is the balance of. */
export function DeepSeekBalanceSection({ row }: { row: ProviderRow }) {
  const { view, ask, asking } = useBalance(row);
  const now = useNow(30_000);
  // While the balance reads fine, topping up is a link in the head; once it is too low it is the
  // section's main action, and while there is no balance there is nothing to top up from here.
  const headLink = view.kind === 'read' && view.balance.isAvailable;
  return (
    <section className="provider-step dsb-section" data-testid="deepseek-balance">
      <div className="ps-head">
        <span className="ps-title">DeepSeek account balance</span>
        {headLink && (
          <span className="ps-link">
            <a href={DEEPSEEK_TOP_UP_URL} target="_blank" rel="noreferrer">
              Top up on DeepSeek ↗
            </a>
          </span>
        )}
      </div>
      <BalanceCard view={view} ask={ask} asking={asking} now={now} />
    </section>
  );
}

function RefreshButton({ label, ask, asking, disabled }: { label: string; ask: () => void; asking: boolean; disabled?: boolean }) {
  return (
    <Button size="small" icon={<ReloadOutlined />} loading={asking} disabled={disabled} onClick={ask}>
      {label}
    </Button>
  );
}

function BalanceCard({ view, ask, asking, now }: { view: BalanceView; ask: () => void; asking: boolean; now: number }) {
  if (view.kind === 'loading') {
    return (
      <div className="dsb-card" aria-busy="true">
        <div className="dsb-top">
          <div className="dsb-skel-head">
            <div className="dsb-cap">Total</div>
            <div className="dsb-skel dsb-skel-total" />
          </div>
          <div className="dsb-right">
            Checking balance…
            <RefreshButton label="Refresh" ask={ask} asking={false} disabled />
          </div>
        </div>
        <div className="dsb-split">
          <div className="dsb-bar" />
          <div className="dsb-skel-legend">
            <div className="dsb-skel" />
            <div className="dsb-skel" />
          </div>
        </div>
      </div>
    );
  }

  if (view.kind === 'failed') {
    // What happened is the server's sentence; what to do about it is this page's.
    const next = view.reason === 'KEY_REJECTED' ? ' Paste a valid key above and save, then retry.' : '';
    return (
      <div className="dsb-card fail">
        <div className="dsb-alert">
          <WarningFilled className="ic" />
          <div>
            <div className="t">Couldn't get the balance</div>
            <div className="d">
              {view.message}
              {next}
            </div>
          </div>
        </div>
        <div className="dsb-top dsb-unknown-row">
          <div className="dsb-unknown">Balance unknown</div>
          <div className="dsb-right">
            {view.triedAt && `Tried ${balanceAgo(view.triedAt, now)}`}
            <RefreshButton label="Retry" ask={ask} asking={asking} />
          </div>
        </div>
      </div>
    );
  }

  const { balances, isAvailable, fetchedAt, sharedWith } = view.balance;
  const updated = (
    <div className="dsb-right">
      Updated {balanceAgo(fetchedAt, now)}
      <RefreshButton label="Refresh" ask={ask} asking={asking} />
    </div>
  );
  const currencies = balances.map((balance, i) => (
    <Currency key={balance.currency} balance={balance} first={i === 0} low={!isAvailable} updated={i === 0 ? updated : null} />
  ));
  return (
    <>
      {isAvailable ? (
        <div className="dsb-card">{currencies}</div>
      ) : (
        <div className="dsb-card low">
          <div className="dsb-alert">
            <ExclamationCircleFilled className="ic" />
            <div>
              <div className="t">Balance too low — DeepSeek calls will fail</div>
              <div className="d">
                DeepSeek reports this account can't pay for more requests. Every session using a key on
                this account will fail at its next request. Orbit can't top up for you.
              </div>
            </div>
          </div>
          {currencies}
          <div className="dsb-actions">
            <Button type="primary" size="small" icon={<ExportOutlined />} href={DEEPSEEK_TOP_UP_URL} target="_blank" rel="noreferrer">
              Top up on DeepSeek
            </Button>
            <span className="dsb-hint">Opens platform.deepseek.com — refresh here when you're done.</span>
          </div>
        </div>
      )}
      <div className="dsb-note">
        {NOTE}
        {balances.length > 1 && <div>{MULTI_CURRENCY}</div>}
      </div>
      {sharedWith.length > 0 && (
        <div className="dsb-shared">
          Same DeepSeek account as{' '}
          {sharedWith.map((sibling, i) => (
            <span key={sibling.id}>
              {i > 0 && (i === sharedWith.length - 1 ? ' and ' : ', ')}
              <b>{sibling.label}</b>
            </span>
          ))}{' '}
          — {sharedWith.length === 1 ? 'both' : 'all'} show this balance.
        </div>
      )}
    </>
  );
}

/** One currency of the balance: its total, then how much of it is granted and how much topped up. */
function Currency({
  balance,
  first,
  low,
  updated,
}: {
  balance: ProviderBalanceAmount;
  first: boolean;
  low: boolean;
  updated: ReactNode;
}) {
  const split = balanceSplit(balance);
  return (
    <div className="dsb-cur">
      <div className="dsb-top">
        <div>
          {first && <div className="dsb-cap">Total</div>}
          <div className={`dsb-total${first ? '' : ' minor'}${low ? ' low' : ''}`}>
            {formatBalance(balance.totalBalance, balance.currency)}
            <span className="cur">{balance.currency}</span>
          </div>
        </div>
        {updated}
      </div>
      <div className="dsb-split">
        <div className="dsb-bar">
          {split && (
            <>
              <span className="g" style={{ width: `${split.granted}%` }} />
              <span className="t" style={{ width: `${split.toppedUp}%` }} />
            </>
          )}
        </div>
        <div className="dsb-legend">
          <span>
            <i className="gk" />
            Granted<b>{formatBalance(balance.grantedBalance, balance.currency)}</b>
          </span>
          <span>
            <i className="tk" />
            Topped up<b>{formatBalance(balance.toppedUpBalance, balance.currency)}</b>
          </span>
        </div>
      </div>
    </div>
  );
}
