import { Popover } from 'antd';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { PlanUsageSnapshot } from '@orbit/shared';
import { bindingPlanUsageRow, currentPlanUsageRows } from '../lib/planUsage';
import {
  CodexResetConfirm,
  CodexResetCreditCard,
  useCodexResetCredit,
  type CodexResetContext,
} from './CodexResetCredit';

const fmtReset = (d?: string): string =>
  d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

/** What Tab moves between inside the popover. */
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Whose quota the popover's windows are: one of the runner's Codex accounts, where it has several.
 *  `note` says how a new session came to it when nothing picked one. */
export interface PlanUsageAccount {
  label: string;
  note?: string;
}

// Compact plan-usage indicator for the composer footer (right of the effort pill).
// The pill shows the binding/primary window; hover or press reveals every reported window, the account
// they belong to and, for a session on the runner's own Codex sign-in, its earned reset credits.
export function PlanUsageIndicator({
  usage,
  reset,
  account,
}: {
  usage: PlanUsageSnapshot;
  reset?: CodexResetContext;
  account?: PlanUsageAccount;
}) {
  const rows = currentPlanUsageRows(usage);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Opened by a press rather than a hover: focus follows into the popover as it would into any
  // dialog. A hover never pulls focus out of what the user is typing in.
  const focusOnOpen = useRef(false);
  const credit = useCodexResetCredit(reset, open, () => panel.current?.focus());
  // The pill's one number is the window that stops this login (bindingPlanUsageRow), not the first.
  const primary = bindingPlanUsageRow(rows);
  if (!primary) return null;

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    // The popover is portaled to the end of the page, so Tab would otherwise leave it for nowhere.
    event.preventDefault();
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      close();
      return;
    }
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length].focus();
  };

  const pop = (
    <div
      ref={panel}
      className={`cu-pop${reset ? ' cu-pop-reset' : ''}`}
      role="dialog"
      aria-label="Plan usage"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
    >
      {account && (
        <div className="cu-account">
          <div className="cu-head">
            <span className="cu-label">Account</span>
            <span className="cu-account-name">{account.label}</span>
          </div>
          {account.note && <div className="cu-reset">{account.note}</div>}
        </div>
      )}
      {rows.map(({ key, label, groupLabel, window, percent, nearLimit }) => {
        return (
          <div className="cu-row" key={key}>
            {groupLabel && <div className="cu-label">{groupLabel}</div>}
            <div className="cu-head">
              <span className="cu-label">{label}</span>
              <span className="cu-pct">{percent}%</span>
            </div>
            <div className={`runner-util ${nearLimit ? 'full' : ''}`}>
              <span className="runner-util-fill" style={{ width: `${percent}%` }} />
            </div>
            {window.resetsAt && (
              <div className="cu-reset">Resets {fmtReset(window.resetsAt)}</div>
            )}
          </div>
        );
      })}
      <CodexResetCreditCard state={credit} />
    </div>
  );
  return (
    <>
      <Popover
        content={pop}
        title="Plan usage"
        placement="topRight"
        // On a phone the composer drops its spacer and this pill sits mid-row, where the popover fits
        // against neither of its edges. antd's corner placements only flip, which leaves it hanging
        // off the screen (and Chrome then widens the whole page to fit it), so shift it back in.
        align={{ overflow: { adjustX: true, adjustY: true, shiftX: true } }}
        trigger={['hover', 'click']}
        // The confirmation is a modal over this popover: pressing inside it is not leaving the popover.
        open={open || credit.confirmOpen}
        onOpenChange={(next) => {
          if (!next && credit.confirmOpen) return;
          setOpen(next);
        }}
        afterOpenChange={(visible) => {
          if (visible && focusOnOpen.current) panel.current?.focus();
          focusOnOpen.current = false;
        }}
      >
        <button
          ref={trigger}
          type="button"
          className={`composer-pill composer-usage ${primary.nearLimit ? 'full' : ''}`}
          aria-label={`Plan usage ${primary.percent}%${credit.busy ? ', reset in progress' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            focusOnOpen.current = !open;
          }}
        >
          <span className="composer-usage-bar">
            <span className="composer-usage-fill" style={{ width: `${primary.percent}%` }} />
          </span>
          <span className="composer-usage-pct">{primary.percent}%</span>
          {credit.busy && <span className="composer-usage-resetting" aria-hidden="true" />}
        </button>
      </Popover>
      {reset && <CodexResetConfirm state={credit} usagePercent={primary.percent} />}
    </>
  );
}
