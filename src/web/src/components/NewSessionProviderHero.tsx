import { useState } from 'react';
import { Popover } from 'antd';
import { Link } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import { PROVIDER_GLYPHS } from '../lib/providerGlyphs';
import type { ProviderChoice } from '../lib/sessionProviderChoices';

/** The brand mark. Same construction as the /providers tile (gradient + white glyph), sized up:
 *  at hero size it carries a soft shadow in its own brand colour, which a 24px chip can't. An
 *  account pool wears its vendor's mark with the number of accounts in its corner. */
function ProviderMark({ choice, size }: { choice: ProviderChoice; size: number }) {
  if (choice.poolSize === undefined) return <BrandMark choice={choice} size={size} />;
  return (
    <span className="np-mark-wrap">
      <BrandMark choice={choice} size={size} />
      <span
        className="np-pool-badge"
        style={{ fontSize: Math.max(9, Math.round(size * 0.2)) }}
        aria-label={`${choice.poolSize} account${choice.poolSize === 1 ? '' : 's'}`}
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
  runnerId,
  disabled,
  note,
  projectIntent = false,
}: {
  current: ProviderChoice;
  choices: ProviderChoice[];
  onPick: (slug: string) => void;
  /** The machine these engines live on — the sign-in link has to name it, since the Providers
   *  page lists every runner and only this one's row is the answer. */
  runnerId: string;
  /** A live/locked session has no choice to make; the hero then reads as a label. */
  disabled?: boolean;
  /** Transient line under the summary (what a switch just changed, and where it was saved). */
  note?: string | null;
  /** The Projects entry point still uses this same provider picker; only its framing copy changes. */
  projectIntent?: boolean;
}) {
  const [open, setOpen] = useState(false);
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
        <span className="np-row-name">{choice.label}</span>
        <span className="np-row-model np-fix">{choice.unavailable}</span>
      </Link>
    ) : (
      <button
        key={choice.slug}
        type="button"
        className={`np-row${choice.slug === current.slug ? ' on' : ''}`}
        onClick={() => {
          setOpen(false);
          if (choice.slug !== current.slug) onPick(choice.slug);
        }}
      >
        <ProviderMark choice={choice} size={20} />
        <span className="np-row-name">{choice.label}</span>
        <span className="np-row-model">{choice.modelLabel}</span>
      </button>
    );

  // One flat list: whose subscription or key each row spends is already carried by its brand mark
  // and by the summary under the card, so section headers would only be chrome between the user
  // and the pick. Engines still come first (that's the order `choices` arrives in). The accounts
  // an account pool runs on fold away under it: picking the pool is the usual answer, and one of
  // them on its own is the exception.
  const list = (
    <div className="np-list">
      {choices.filter((choice) => !choice.inPool).map(row)}
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
        {!disabled && <span className="np-chev">▾</span>}
      </span>
    </button>
  );

  return (
    <div className="np-hero">
      <div className="np-title">
        {projectIntent ? 'Start a new project' : 'Start a new session'}
      </div>
      <div className="np-sub">
        {projectIntent
          ? 'Describe what you want done — define the goal, acceptance criteria, and task breakdown together.'
          : 'Describe the task — Orbit remembers who runs it.'}
      </div>
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
            {current.modelLabel}
            <span className="np-dot">·</span>
            {/* No funding label in the healthy state: for a configured provider it's a constant the
                user already set, and it isn't actionable here. The credential earns a line only when
                it's broken — the `unavailable` branch above ("… · Fix it"). */}
            <Link to="/providers">Manage</Link>
          </>
        )}
      </div>
      {note && <div className="np-note">{note}</div>}
    </div>
  );
}
