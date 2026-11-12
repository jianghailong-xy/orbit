import { useState, type ReactNode } from 'react';
import { CheckOutlined, ExclamationOutlined } from '@ant-design/icons';
import {
  MAIN_CHECKOUT_CARD_HANDLED_COPY,
  MAIN_CHECKOUT_CARD_VISIBLE_FILES,
  MAIN_CHECKOUT_COPY,
  mainCheckoutBarStatus,
  mainCheckoutCardHandled,
  mainCheckoutCardSubtitle,
  mainCheckoutCardTitle,
  mainCheckoutMoreFiles,
  mainCheckoutMoveHint,
  mainCheckoutPushLabel,
  mainCheckoutResultLine,
  mainCheckoutReviewAndCommit,
  mainCheckoutTruncatedNote,
  shortSha,
  type MainCheckoutActionResult,
  type MainCheckoutChangedNotice,
  type MainCheckoutLinkAction,
  type MainCheckoutRepoHealth,
  type MainCheckoutResultNotice,
} from '@orbit/shared';
import {
  askAboutChangesPrompt,
  askCombinePrompt,
  rescueSessionPrompt,
  askRebasePushPrompt,
  useMainCheckoutHost,
  useMainCheckoutResults,
  type MainCheckoutHost,
} from '../lib/mainCheckout';
import { Menu } from './ui/Menu';

const LEFT_KEY = 'mck-card-left:';

/** Board 01 B: the end of a worktree turn found new or changed files in the main checkout. The person decides whose
 *  they are — this session's (Move), main's (Review and commit), or nobody's yet (⋯). Once a later result line took
 *  them, or the checkout no longer holds them, the card stays as history with one muted line and no actions. */
export function MainCheckoutCard({ notice, seq }: { notice: MainCheckoutChangedNotice; seq?: number }) {
  const host = useMainCheckoutHost();
  const transcript = useMainCheckoutResults();
  const writtenAt = seq === undefined ? undefined : transcript.writtenAt.get(seq);
  const handled = mainCheckoutCardHandled(
    notice,
    transcript.results.filter((r) => seq === undefined || r.seq > seq).map((r) => r.result),
    host?.health,
    writtenAt ? (Date.now() - Date.parse(writtenAt)) / 1000 : null,
  );
  const leftKey = `${LEFT_KEY}${host?.sessionId ?? ''}:${notice.fingerprint}`;
  const [left, setLeft] = useState(() => {
    try {
      return localStorage.getItem(leftKey) === '1';
    } catch {
      return false;
    }
  });
  const leave = () => {
    setLeft(true);
    try {
      localStorage.setItem(leftKey, '1');
    } catch {
      // the card only stays folded for this view
    }
  };
  const shown = notice.files.slice(0, MAIN_CHECKOUT_CARD_VISIBLE_FILES);
  const hidden = notice.fileCount - shown.length;
  const branch = notice.branch ?? 'HEAD';
  const actions = !!host?.actionsSupported;
  // A handled card keeps its buttons where they were, unpressable.
  const busy = !!host?.inFlight || !!handled;
  const canMove = actions && !!host?.sessionId && !!host?.sessionBranch;
  const sub = mainCheckoutCardSubtitle(notice.root, notice.branch);
  // The subtitle's path and branch read as code, as on the board.
  const where = notice.branch ? `${notice.root} on ${notice.branch}` : notice.root;
  const subRest = sub.slice(where.length);
  return (
    <div className="mck-card" data-seq={seq}>
      <div className="mck-card-head">
        <span className="mck-card-icon" aria-hidden="true">
          !
        </span>
        <div className="mck-card-heading">
          <div className="mck-card-title">{mainCheckoutCardTitle(notice.fileCount, notice.truncated)}</div>
          <div className="mck-card-sub">
            <code>{notice.root}</code>
            {notice.branch && (
              <>
                {' on '}
                <code>{notice.branch}</code>
              </>
            )}
            {subRest}
          </div>
        </div>
      </div>
      <div className="mck-card-files">
        {shown.map((f) => (
          <button
            key={f.path}
            type="button"
            className="mck-file"
            disabled={!actions || !!handled}
            onClick={() => host?.openReview(f.path)}
            title={actions && !handled ? `Review ${f.path}` : f.path}
          >
            <span className={`mck-file-st st-${f.status.toLowerCase()}`}>{f.status}</span>
            <span className="mck-file-path">{f.path}</span>
            <FileStat file={f} />
          </button>
        ))}
        {hidden > 0 && <div className="mck-card-more">{mainCheckoutMoreFiles(hidden)}</div>}
        {notice.truncated && <div className="mck-card-more">{mainCheckoutTruncatedNote()}</div>}
      </div>
      {actions && !left && (
        <div className="mck-card-actions">
          <div className="mck-card-buttons">
            {canMove && (
              <button
                type="button"
                className="mck-btn mck-btn-primary"
                disabled={busy}
                onClick={() =>
                  host!.move({
                    root: notice.root,
                    fingerprint: notice.fingerprint,
                    files: notice.files.map((f) => f.path),
                    targetSessionId: host!.sessionId!,
                  })
                }
              >
                {MAIN_CHECKOUT_COPY.moveToThisWorktree}
              </button>
            )}
            <button type="button" className="mck-btn" disabled={busy} onClick={() => host!.openReview()}>
              {mainCheckoutReviewAndCommit(branch)}
            </button>
            <Menu
              side="bottom"
              align="end"
              disabled={!!handled}
              popupClassName="mck-menu"
              items={[
                {
                  key: 'rescue',
                  disabled: busy,
                  textValue: MAIN_CHECKOUT_COPY.saveAndClean,
                  label: <MenuRow label={MAIN_CHECKOUT_COPY.saveAndClean} hint={MAIN_CHECKOUT_COPY.saveAndCleanHint} />,
                  onSelect: () => host!.rescue({ root: notice.root, fingerprint: notice.fingerprint }),
                },
                ...(host!.askAgent
                  ? [
                      {
                        key: 'ask',
                        textValue: MAIN_CHECKOUT_COPY.askAgent,
                        label: <MenuRow label={MAIN_CHECKOUT_COPY.askAgent} hint={MAIN_CHECKOUT_COPY.askAgentHint} />,
                        onSelect: () => host!.askAgent!(askAboutChangesPrompt(notice)),
                      },
                    ]
                  : []),
                { key: 'leave', label: MAIN_CHECKOUT_COPY.leaveAsIs, onSelect: leave },
              ]}
              trigger={
                <button type="button" className="mck-btn mck-btn-more" aria-label="More actions">
                  ⋯
                </button>
              }
            />
          </div>
          {canMove && !handled && <div className="mck-card-hint">{moveHint(host!.sessionBranch!)}</div>}
          {handled && <div className="mck-card-hint mck-card-handled">{MAIN_CHECKOUT_CARD_HANDLED_COPY[handled]}</div>}
        </div>
      )}
      {handled && (!actions || left) && (
        <div className="mck-card-actions mck-card-handled">{MAIN_CHECKOUT_CARD_HANDLED_COPY[handled]}</div>
      )}
    </div>
  );
}

function moveHint(branch: string): ReactNode {
  const text = mainCheckoutMoveHint(branch);
  const i = text.indexOf(branch);
  return (
    <>
      {text.slice(0, i)}
      <code>{branch}</code>
      {text.slice(i + branch.length)}
    </>
  );
}

function MenuRow({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="mck-menu-row">
      <span className="mck-menu-label">{label}</span>
      <span className="mck-menu-hint">{hint}</span>
    </span>
  );
}

function FileStat({ file }: { file: { binary?: boolean; additions?: number; deletions?: number } }) {
  if (file.binary) return <span className="mck-file-stat session-file-bin">binary</span>;
  return (
    <span className="mck-file-stat">
      {!!file.additions && <span className="add">+{file.additions}</span>}
      {!!file.deletions && <span className="del">−{file.deletions}</span>}
    </span>
  );
}

/** Board 03: one action's outcome, as a line of the conversation it was pressed in. */
export function MainCheckoutResultRow({
  notice,
  seq,
  isolated = true,
}: {
  notice: MainCheckoutResultNotice;
  seq?: number;
  isolated?: boolean;
}) {
  const host = useMainCheckoutHost();
  const r = notice.result;
  const line = mainCheckoutResultLine(r, { sessionId: host?.sessionId, isolated });
  // The server wrote the line knowing the target session's title; its words win, the lead and link are the same.
  const text = notice.notice || line.text;
  const lead = text.startsWith(line.lead) ? line.lead : '';
  const link = line.link ? linkHandler(line.link.action, r, host) : null;
  // A link the sentence already says (MOVE_CONFLICT's "ask the agent to combine them") is drawn in place; any other
  // follows the sentence.
  const rest = text.slice(lead.length);
  const inline = link && line.link ? rest.lastIndexOf(line.link.label) : -1;
  const linkButton = link && line.link && (
    <button type="button" className="mck-link" onClick={link}>
      {line.link.label}
    </button>
  );
  return (
    <div className={`mck-result mck-result-${line.tone}`} data-seq={seq}>
      <span className="mck-result-icon" aria-hidden="true">
        {line.tone === 'ok' ? <CheckOutlined /> : <ExclamationOutlined />}
      </span>
      <span className="mck-result-text">
        {lead && <strong>{lead}</strong>}
        {inline >= 0 ? (
          <>
            {withCode(rest.slice(0, inline), r)}
            {linkButton}
            {withCode(rest.slice(inline + line.link!.label.length), r)}
          </>
        ) : (
          <>
            {withCode(rest, r)}
            {linkButton && <> {linkButton}</>}
          </>
        )}
      </span>
    </div>
  );
}

function linkHandler(
  action: MainCheckoutLinkAction,
  r: MainCheckoutActionResult,
  host: MainCheckoutHost | null,
): (() => void) | null {
  if (!host) return null;
  switch (action) {
    case 'view-changes':
      return host.viewChanges ?? null;
    case 'review-again':
      return host.actionsSupported ? () => host.openReview() : null;
    case 'push':
      return host.actionsSupported ? host.push : null;
    case 'clean-up-checkout':
      return host.cleanUp ?? null;
    case 'cancel':
      return () => host.cancel(r.requestId);
    case 'ask-agent-combine':
      return host.askAgent ? () => host.askAgent!(askCombinePrompt(r)) : null;
    case 'ask-agent-rebase-push':
      return host.askAgent ? () => host.askAgent!(askRebasePushPrompt(r)) : null;
    case 'open-in-new-session':
      return host.openNewSession && r.rescueBranch ? () => host.openNewSession!(rescueSessionPrompt(r)) : null;
    default:
      return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Branches, commits and paths in a result line read as code (board 03). */
function withCode(text: string, r: MainCheckoutActionResult): ReactNode {
  const tokens = [
    r.rescueBranch,
    r.remoteBefore && r.remoteAfter ? `${shortSha(r.remoteBefore)}..${shortSha(r.remoteAfter)}` : undefined,
    r.remoteAfter ? shortSha(r.remoteAfter) : undefined,
    r.head ? shortSha(r.head) : undefined,
    ...(r.paths ?? []),
  ].filter((t): t is string => !!t);
  if (tokens.length === 0) return text;
  const unique = [...new Set(tokens)].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${unique.map(escapeRe).join('|')})`, 'g');
  return text.split(re).map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

/** How many changed files the heartbeat says the checkout holds; an older runner reports only the path list. */
export function mainCheckoutFileCount(health: MainCheckoutRepoHealth | null | undefined): number {
  if (!health) return 0;
  if (typeof health.fileCount === 'number') return health.fileCount;
  return health.state === 'dirty' ? (health.paths?.length ?? 0) : 0;
}

/** Board 01⑤ / 02④: the main checkout's standing state, above the worktree bar (and the only Git bar of a Shared
 *  session). Drawn while it has uncommitted files or commits its upstream doesn't. */
export function MainCheckoutBar({ shared }: { shared?: boolean }) {
  const host = useMainCheckoutHost();
  const health = host?.health;
  if (!host || !health) return null;
  const files = mainCheckoutFileCount(health);
  const ahead = health.ahead ?? 0;
  if (files === 0 && ahead === 0) return null;
  const upstream = health.upstream ?? (health.branch ? `origin/${health.branch}` : 'origin');
  const busy = !!host.inFlight;
  return (
    <div className="wt-bar mck-bar">
      <div className="wt-row">
        {files > 0 && <span className="mck-bar-dot" aria-hidden="true" />}
        <span className="mck-bar-label">{MAIN_CHECKOUT_COPY.label}</span>
        {health.branch && <code className="mck-bar-branch">{health.branch}</code>}
        <span className="mck-bar-status">{mainCheckoutBarStatus(files, ahead)}</span>
        <span className="wt-spacer" />
        {host.actionsSupported && files > 0 && (
          <button type="button" className="wt-merge-btn mck-bar-btn" disabled={busy} onClick={() => host.openReview()}>
            {shared ? MAIN_CHECKOUT_COPY.reviewAndCommitShort : MAIN_CHECKOUT_COPY.review}
          </button>
        )}
        {host.actionsSupported && ahead > 0 && (
          <button type="button" className="wt-merge-btn mck-bar-btn" disabled={busy} onClick={host.push}>
            {mainCheckoutPushLabel(upstream)}
          </button>
        )}
      </div>
    </div>
  );
}
