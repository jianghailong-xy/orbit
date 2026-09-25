import {
  AimOutlined,
  BranchesOutlined,
  BulbOutlined,
  CheckOutlined,
  ExclamationCircleOutlined,
  FlagOutlined,
  ForkOutlined,
  TagOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import {
  WIKI_KIND_LABELS,
  WIKI_OP_LABELS,
  wikiKindWord,
  WIKI_STATUS_LABELS,
  WIKI_TRUST_LABELS,
  WIKI_TRUST_TONE,
  type WikiAnchorMark as AnchorMarkValue,
  type WikiEntryKind,
  type WikiTone,
  type WikiTrust,
} from '../lib/wiki';

/**
 * The Wiki's marks: the kind icon, the trust badge, the anchor word, the op chip and the change dot.
 *
 * ONE VOCABULARY, DRAWN ONCE. The design's own rule (§12.1) is that these five marks read the same on
 * the home page, the topic grid, the drawer and Review, and that the words come from `lib/wiki.ts`
 * rather than from the component — iOS draws the same five from its own copy table, held to this one
 * by a parity test. What is here is the drawing: which AntD glyph stands for a kind, and which tone
 * class a mark takes.
 *
 * The tones are the app's own `.tdp-badge` tones, plus one the task detail panel did not have: the
 * deep `tone-owner` an owner-written entry wears, which is the inverse surface rather than a colour,
 * because "you wrote this" is not a severity.
 */

const KIND_ICONS: Record<WikiEntryKind, ReactNode> = {
  principle: <FlagOutlined />,
  convention: <TagOutlined />,
  // A decision forks; a commit is a branch. The two read apart at 13px, which the mock's own sheet
  // relies on (it draws `i-fork` and `i-branches` side by side in 02).
  decision: <ForkOutlined />,
  pitfall: <WarningOutlined />,
  recipe: <ToolOutlined />,
  concept: <BulbOutlined />,
  assumption: <ExclamationCircleOutlined />,
};

export function wikiKindIcon(kind: string): ReactNode {
  return KIND_ICONS[kind as WikiEntryKind] ?? <BranchesOutlined />;
}

export function WikiKindMark({ kind, className = 'wk-kind' }: { kind: string; className?: string }) {
  return (
    <span className={className} title={WIKI_KIND_LABELS[kind as WikiEntryKind] ?? kind} aria-hidden="true">
      {wikiKindIcon(kind)}
    </span>
  );
}

/**
 * Who confirmed an entry: Owner (deep), Confirmed (blue), Proposed (grey), Web-derived (amber).
 *
 * `withIcon` adds the tick the drawer's own header wears; the lists leave it off so the column stays
 * one word wide, which is what the mock's grid measures its three trailing columns against.
 */
export function WikiTrustBadge({ trust, withIcon }: { trust: WikiTrust; withIcon?: boolean }) {
  return (
    <span className={`tdp-badge tone-${WIKI_TRUST_TONE[trust]}`}>
      {withIcon && trust === 'confirmed' ? <CheckOutlined /> : null}
      {WIKI_TRUST_LABELS[trust]}
    </span>
  );
}

/** An entry's own status, where a page says it instead of its trust (the decision log's rows). */
export function WikiStatusBadge({ status }: { status: string }) {
  const tone = status === 'active' ? 'green' : status === 'proposed' ? 'blue' : 'muted';
  return <span className={`tdp-badge tone-${tone}`}>{WIKI_STATUS_LABELS[status] ?? status}</span>;
}

/**
 * The anchor column: `✓ 4db4f9f` when it still holds, `Changed`/`Missing` when it does not.
 *
 * `null` draws nothing at all — an anchor nobody has re-checked is not a warning.
 */
export function WikiAnchorMark({ mark }: { mark: AnchorMarkValue | null }) {
  if (!mark) return null;
  return (
    <span className={`wk-anchor ${mark.tone === 'green' ? 'ok' : mark.tone}`}>
      {mark.tone === 'green' ? (
        <CheckOutlined />
      ) : mark.tone === 'amber' ? (
        <WarningOutlined />
      ) : (
        <ExclamationCircleOutlined />
      )}
      <span className="wk-mono">{mark.word}</span>
    </span>
  );
}

/** The op a Review card is about, or a timeline row's change: ADD / AMEND / SUPERSEDE / RETIRE. */
export function WikiOpChip({ op }: { op: string }) {
  const tone = op === 'add' ? 'add' : op === 'amend' || op === 'supersede' ? 'amend' : 'retire';
  return <span className={`wk-op ${tone}`}>{WIKI_OP_LABELS[op] ?? op.toUpperCase()}</span>;
}

/** A change's dot, and the trust it left behind: owner (deep), confirmed (blue), proposed (grey). */
export function WikiDot({ tone }: { tone: WikiTone }) {
  const cls = tone === 'owner' ? 'owner' : tone === 'blue' || tone === 'green' ? 'confirmed' : tone === 'amber' ? 'amber' : 'proposed';
  return <span className={`wk-dot ${cls}`} aria-hidden="true" />;
}

/** A path, a sha or a command, in the app's mono face. */
export function WikiMono({ children }: { children: ReactNode }) {
  return <code className="wk-mono">{children}</code>;
}

/** The pin an entry can wear. Phase 1 has no writer for it; the drawer shows the flag when it is set. */
export function WikiPinnedBadge() {
  return <span className="tdp-badge tone-muted">Pinned</span>;
}

/**
 * The one place an anchor's aim glyph is drawn, so the drawer's anchor list and the topic page's
 * inline anchors cannot drift into two different marks.
 */
export function WikiAim() {
  return <AimOutlined className="ic aim" />;
}
