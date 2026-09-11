import { Popover } from 'antd';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { PlanUsageSnapshot } from '@orbit/shared';
import { planUsageRows } from '../lib/planUsage';
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

// Compact plan-usage indicator for the composer footer (right of the effort pill).
// The pill shows the binding/primary window; hover or press reveals every reported window and, for a
// session on the runner's own Codex sign-in, its earned reset credits.
export function PlanUsageIndicator({ usage, reset }: { usage: PlanUsageSnapshot; reset?: CodexResetContext }) {
  const rows = planUsageRows(usage);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Opened by a press rather than a hover: focus follows into the popover as it would into any
  // dialog. A hover never pulls focus out of what the user is typing in.
  const focusOnOpen = useRef(false);
  const credit = useCodexResetCredit(reset, open, () => panel.current?.focus());
  if (rows.length === 0) return null;
  const primary = rows[0];

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
