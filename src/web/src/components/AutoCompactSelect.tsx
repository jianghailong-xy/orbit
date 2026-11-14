import { Select } from './ui/Select';

/**
 * The size Claude Code compacts a conversation near: its own variable, in tokens, so a workspace's
 * choice reaches every engine it starts the way the rest of its environment does. Left unset, a 1M
 * model compacts close to 1M.
 */
export const AUTO_COMPACT_VARIABLE = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

const DEFAULT = 'default';
/** The sizes on offer, Default (the variable unset) first; the session Settings drawer offers the same. */
export const AUTO_COMPACT_SIZES = [
  { value: DEFAULT, label: 'Default' },
  { value: '700000', label: '700K tokens' },
  { value: '500000', label: '500K tokens' },
  { value: '300000', label: '300K tokens' },
];

/** The workspace form's environment rows with this size in place of whatever was there, or without
 *  the variable for Default. */
export function withAutoCompact<Row extends { key: string; value: string }>(rows: Row[], size: string): (Row | { key: string; value: string })[] {
  const others = rows.filter((row) => row.key.trim() !== AUTO_COMPACT_VARIABLE);
  return size === DEFAULT ? others : [...others, { key: AUTO_COMPACT_VARIABLE, value: size }];
}

/**
 * How large a workspace lets its Claude Code conversations get before they are compacted. Reading the
 * whole conversation back on every call is most of what a long session spends, and compacting is what
 * shrinks it, at the price of whatever the summary leaves out. So it is a choice, and off by default:
 * in a trial on 2026-11-01, sessions compacted every few calls lost judgment on a hard task and spent
 * more, not less (docs/quota-limit-retry-design.md §10.5), which is why the sizes on offer stop at 300K.
 * A size typed under Environment variables is shown as it is.
 */
export function AutoCompactSelect({ value, onChange }: { value: string | undefined; onChange: (size: string) => void }) {
  const size = value?.trim() || DEFAULT;
  const options = AUTO_COMPACT_SIZES.some((row) => row.value === size) ? AUTO_COMPACT_SIZES : [...AUTO_COMPACT_SIZES, { value: size, label: `${size} tokens` }];
  return (
    <div className="rd-form-field">
      <div className="rd-form-label">Compact Claude Code sessions at</div>
      <Select
        className="rd-codex-account"
        value={size}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        options={options}
      />
      <div className="rd-path-hint rd-path-muted">
        Claude Code summarizes a conversation when it gets close to this size. A smaller size spends less quota on
        long sessions, but they can lose detail. Applies from the next time a session starts.
      </div>
    </div>
  );
}
