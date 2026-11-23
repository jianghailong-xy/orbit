import { UNCLASSIFIED_ADMISSION } from './account-health';

/**
 * The words of the `account-needs-action` push (docs/routing-account-health-design.md §8), in one place so the push,
 * the account row and the contract spec read the same sentence.
 *
 * `product`: what is refused, as the owner names it (an engine's label such as "Cursor", or a key's provider label).
 * A classified refusal quotes the provider; the breaker's guess counts the runs: the first trip took two strikes, each
 * later one a refused trial, so `trips + 1` runs failed to start.
 */
export function accountNeedsActionBody(input: { product: string; kind: string; said: string | null; trips: number }): string {
  if (input.kind === UNCLASSIFIED_ADMISSION) {
    return `${input.product} failed to start ${input.trips + 1} runs on this account. Orbit is using your other accounts.`;
  }
  const quoted = input.said ? `: "${input.said}"` : '';
  return `${input.product} can't run on this account${quoted}. Orbit is using your other accounts and tries this one again from time to time.`;
}

/** The account row's line (§8, item 2) for a live BLOCKED row; `blockedUntil` is when the next trial is due. */
export function accountRowLine(input: {
  product: string; kind: string; said: string | null; trips: number; strikes?: number;
}): string {
  if (input.kind === UNCLASSIFIED_ADMISSION) return `Not used for now · failed to start ${input.trips + 1} runs`;
  return input.said ? `Needs action · ${input.product} said "${input.said}"` : `Needs action · ${input.product} refused this account`;
}
