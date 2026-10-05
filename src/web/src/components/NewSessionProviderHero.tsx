import { Fragment, useState } from 'react';
import { Popover } from 'antd';
import { Link } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import { PROVIDER_GLYPHS } from '../lib/providerGlyphs';
import type { AccountChoice, ProviderChoice } from '../lib/sessionProviderChoices';

/** The brand mark. Same artwork and tile as /providers, sized up:
 *  at hero size it carries a soft shadow in its own brand colour, which a 24px chip can't. An
 *  account pool wears its vendor's mark with the number of accounts (a shared pool's: keys) in its
 *  corner. */
function ProviderMark({ choice, size }: { choice: ProviderChoice; size: number }) {
  if (choice.poolSize === undefined) return <BrandMark choice={choice} size={size} />;
  return (
    <span className="np-mark-wrap">
      <BrandMark choice={choice} size={size} />
      <span
        className="np-pool-badge"
        style={{ fontSize: Math.max(9, Math.round(size * 0.2)) }}
        aria-label={`${choice.poolSize} ${choice.poolUnit ?? 'account'}${choice.poolSize === 1 ? '' : 's'}`}
      >
        {choice.poolSize}
      </span>
    </span>
  );
}

function BrandMark({ choice, size }: { choice: ProviderChoice; size: number }) {
  const glyph = choice.glyphKey ? PROVIDER_GLYPHS[choice.glyphKey] : undefined;
  return (
    <span
      className="provider-tile np-mark"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        background: `linear-gradient(135deg, ${choice.brand.from}, ${choice.brand.to})`,
        border: choice.glyphKey === 'antigravity' ? '1px solid rgba(255,255,255,0.16)' : undefined,
        boxShadow: size >= 40 ? `0 8px 22px ${hexAlpha(choice.brand.to, 0.34)}` : undefined,
      }}
    >
      {glyph ? (
        <svg
          viewBox="0 0 24 24"
          width={Math.round(size * 0.56)}
          height={Math.round(size * 0.56)}
          fill="currentColor"
          style={{ color: '#fff' }}
          dangerouslySetInnerHTML={{ __html: glyph }}
        />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.42) }}>{choice.brand.mono}</span>
      )}
    </span>
  );
}

/** #rrggbb → rgba(), for the mark's own-colour shadow. */
function hexAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(n)) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The New Session middle area: who runs this session.
 *
 * Collapsed to a single identity by default — provider is a sticky choice, so showing every
 * option on every new session would charge the full visual cost for the rare switch. The list
 * opens on click, and the pick is remembered on the workspace, so the common path is: read it, ignore
 * it, start typing.
 */
export function NewSessionProviderHero({
  current,
  choices,
  onPick,
  currentAccount,
  automatic,
  onPickAccount,
  runnerId,
  disabled,
  note,
  currentModelLabel,
  projectIntent = false,
}: {
  current: ProviderChoice;
  choices: ProviderChoice[];
  onPick: (slug: string) => void;
  /** Which of `current`'s accounts the session would start on, when it lists them (`accounts`). */
  currentAccount?: string;
  /** Per engine that lists accounts: whether Automatic is its pick — present only where Automatic is on
   *  offer (the workspace leaves that engine's account to Orbit). On the current engine's pick,
   *  `currentAccount` is the account it would start on. */
  automatic?: Partial<Record<string, boolean>>;
  /** An account row was picked — `null` for Automatic: start on that engine, on that account of it. */
  onPickAccount?: (slug: string, account: string | null) => void;
  /** The machine these engines live on — the sign-in link has to name it, since the Providers
   *  page lists every runner and only this one's row is the answer. */
  runnerId: string;
  /** A live/locked session has no choice to make; the hero then reads as a label. */
  disabled?: boolean;
  /** Transient line under the summary (what a switch just changed, and where it was saved). */
  note?: string | null;
  /** The model this draft will actually send with; provider choices carry the runner default instead. */
  currentModelLabel?: string;
  /** The Projects entry point still uses this same provider picker; only its framing copy changes. */
  projectIntent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const displayedChoices = choices.some((choice) => choice.slug === current.slug) ? choices : [current, ...choices];
  const pinnable = choices.filter((choice) => choice.inPool);
  // Open from the start when the pick already is one of those accounts, so its tick is in view.
  const [pinOpen, setPinOpen] = useState(() => pinnable.some((choice) => choice.slug === current.slug));

  // Naming the runner and the engine, so the Providers page can unfold that machine's card and
  // point at the row — where its Install and Sign in buttons are — instead of leaving the user to
  // find it among every runner they own. The engine named is the one that runs the choice, which
  // for a configured provider is the CLI it borrows rather than its own slug. A problem that is not
  // this machine's (an account pool none of whose accounts can run) names its own page instead.
  const fixLink = (choice: ProviderChoice) =>
    choice.fixHref ?? `/providers?runner=${encodeId(runnerId)}&engine=${choice.fixEngine ?? choice.slug}`;
  const onRunner = (choice: ProviderChoice) => (choice.fixHref ? '' : ' on this runner');
  const modelLabel = currentModelLabel ?? current.modelLabel;

  // An engine this runner hasn't installed, or isn't signed into, can't run a session, so the row
  // doesn't pick it — it goes where the fix lives instead. The identity greys out (it isn't usable
  // yet) while the reason stays lit as the link it now is, so the row states the problem and
  // offers the fix rather than disappearing and leaving the absence to be explained.
  const row = (choice: ProviderChoice) =>
    choice.unavailable ? (
      <Link
        key={choice.slug}
        to={fixLink(choice)}
        className="np-row np-unavailable"
        title={`${choice.label}: ${choice.unavailable}${onRunner(choice)} — fix it on the Providers page`}
        onClick={() => setOpen(false)}
      >
        <ProviderMark choice={choice} size={20} />
        <span className="np-row-name">{choice.label}{choice.labelDetail && <small className="np-label-detail">{choice.labelDetail}</small>}</span>
        <span className="np-row-model np-fix">{choice.unavailable}</span>
      </Link>
    ) : (
      <Fragment key={choice.slug}>
        <button
          type="button"
          className={`np-row${choice.slug === current.slug ? ' on' : ''}`}
          onClick={() => {
            setOpen(false);
            if (choice.slug !== current.slug) onPick(choice.slug);
          }}
        >
          <ProviderMark choice={choice} size={20} />
          <span className="np-row-name">{choice.label}{choice.labelDetail && <small className="np-label-detail">{choice.labelDetail}</small>}</span>
          <span className="np-row-model">{choice.modelLabel}</span>
        </button>
        {choice.accounts && automatic?.[choice.slug] !== undefined && automaticRow(choice)}
        {choice.accounts?.map((account) => accountRow(choice, account))}
      </Fragment>
    );

  // Above the accounts, when the workspace picked none: let the session start on whichever has the most
  // room. Ticked while it is the pick, with the account it would choose named under the card.
  const automaticRow = (choice: ProviderChoice) => {
    const picked = choice.slug === current.slug && automatic?.[choice.slug] === true;
    return (
      <button
        key="automatic"
        type="button"
        className={`np-row np-account${picked ? ' picked' : ''}`}
        aria-pressed={picked}
        onClick={() => {
          setOpen(false);
          if (!picked) onPickAccount?.(choice.slug, null);
        }}
      >
        <span className="np-account-tick" aria-hidden="true">
          {picked ? '✓' : ''}
        </span>
        <span className="np-row-name">Automatic</span>
        <span className="np-row-model">switches to soonest reset</span>
      </button>
    );
  };

  // The engine's accounts, right under it: the tick sits in the mark's column, so the names line up
  // with the engine's own. An account the CLI says is signed out goes to the Providers page, where
  // its sign-in is, the way a signed-out engine does.
  const accountRow = (choice: ProviderChoice, account: AccountChoice) => {
    const picked = choice.slug === current.slug && automatic?.[choice.slug] !== true && account.id === currentAccount;
    return account.unavailable ? (
      <Link
        key={account.id}
        to={fixLink(choice)}
        className="np-row np-account np-unavailable"
        title={`${choice.label} account ${account.label}: ${account.unavailable}${onRunner(choice)} — fix it on the Providers page`}
        onClick={() => setOpen(false)}
      >
        <span className="np-account-tick" aria-hidden="true" />
        <span className="np-row-name">{account.label}</span>
        <span className="np-row-model np-fix">{account.unavailable}</span>
      </Link>
    ) : (
      <button
        key={account.id}
        type="button"
        className={`np-row np-account${picked ? ' picked' : ''}`}
        aria-pressed={picked}
        onClick={() => {
          setOpen(false);
          if (!picked) onPickAccount?.(choice.slug, account.id);
        }}
      >
        <span className="np-account-tick" aria-hidden="true">
          {picked ? '✓' : ''}
        </span>
        <span className="np-row-name">{account.label}</span>
        {account.quota && (
          <span className={`np-row-model${account.nearLimit ? ' near-limit' : ''}`}>{account.quota}</span>
        )}
      </button>
    );
  };
  // One flat list: whose subscription or key each row spends is already carried by its brand mark
  // and by the summary under the card, so section headers would only be chrome between the user
  // and the pick. Engines still come first (that's the order `choices` arrives in). The accounts
  // an account pool runs on fold away under it: picking the pool is the usual answer, and one of
  // them on its own is the exception.
  const list = (
    <div className={`np-list${choices.some((choice) => choice.accounts) ? ' with-accounts' : ''}${displayedChoices.some((choice) => choice.labelDetail) ? ' with-details' : ''}`}>
      {displayedChoices.filter((choice) => !choice.inPool).map(row)}
      {pinnable.length > 0 && (
        <>
          <button
            type="button"
            className="np-row np-pin-toggle"
            aria-expanded={pinOpen}
            onClick={() => setPinOpen((was) => !was)}
          >
            <span className={`np-pin-chev${pinOpen ? ' open' : ''}`} aria-hidden="true">
              ▸
            </span>
            <span className="np-row-name">Pin a specific account</span>
            <span className="np-row-model">{pinnable.length}</span>
          </button>
          {pinOpen && <div className="np-pinned">{pinnable.map(row)}</div>}
        </>
      )}
      <div className="np-sep" />
      <Link to="/providers" className="np-row np-connect" onClick={() => setOpen(false)}>
        <span className="np-plus">+</span>
        <span className="np-row-name">Connect a provider…</span>
      </Link>
    </div>
  );

  const card = (
    <button
      type="button"
      className={`np-card${open ? ' open' : ''}`}
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Provider: ${current.label}`}
    >
      <ProviderMark choice={current} size={56} />
      <span className="np-name">
        {current.label}
        {current.labelDetail && <small className="np-label-detail">{current.labelDetail}</small>}
        {!disabled && <span className="np-chev">▾</span>}
      </span>
    </button>
  );

  return (
    <div className="np-hero">
      {projectIntent && (
        <>
          <div className="np-title">Start a new project</div>
          <div className="np-sub">
            Describe what you want done — define the goal, acceptance criteria, and task breakdown together.
          </div>
        </>
      )}
      {disabled ? (
        card
      ) : (
        <Popover
          content={list}
          trigger="click"
          placement="bottom"
          open={open}
          onOpenChange={setOpen}
          arrow={false}
          overlayClassName="np-pop"
        >
          {card}
        </Popover>
      )}
      {/* The pick is sticky, so the current one can be an engine that machine can no longer run —
          and a session started on it fails minutes later, at the runner. Say so here instead. */}
      {projectIntent ? (
        <div className="np-summary">
          <b>{current.label}</b>
          <span className="np-dot">·</span>
          {current.unavailable ? (
            <>
              {current.unavailable}
              {onRunner(current)}
              <span className="np-dot">·</span>
              <Link to={fixLink(current)}>Fix it</Link>
            </>
          ) : (
            <>
              {modelLabel}
              <span className="np-dot">·</span>
              <Link to="/providers">Manage</Link>
            </>
          )}
        </div>
      ) : current.unavailable ? (
        <div className="np-summary">
          <b>{current.label}</b>
          <span className="np-dot">·</span>
          {current.unavailable}
          {onRunner(current)}
          <span className="np-dot">·</span>
          <Link to={fixLink(current)}>Fix it</Link>
        </div>
      ) : (
        <>
          <div className="np-empty-copy">Send a task to get started.</div>
          <div className="np-current-model">{modelLabel}</div>
        </>
      )}
      {note && <div className="np-note">{note}</div>}
    </div>
  );
}
