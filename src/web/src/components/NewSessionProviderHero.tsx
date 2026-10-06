import { useState } from 'react';
import { Popover } from 'antd';
import { Link } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import { PROVIDER_GLYPHS } from '../lib/providerGlyphs';
import { engineProviderDetail, type EngineChoice, type ProviderChoice } from '../lib/sessionProviderChoices';

/** The brand mark. Same artwork and tile as /providers, sized up: at hero size it carries a soft
 *  shadow in its own brand colour, which a 20px row chip can't. */
function BrandMark({ choice, size }: { choice: Pick<EngineChoice, 'brand' | 'glyphKey'>; size: number }) {
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
 * The New Session middle area: which engine runs this session.
 *
 * Collapsed to a single identity by default — the engine is a sticky choice, so showing every
 * option on every new session would charge the full visual cost for the rare switch. The list
 * opens on click, and the pick is remembered on the workspace, so the common path is: read it, ignore
 * it, start typing. Which provider of the engine the session spends — its own sign-in, an account
 * pool, a key that borrows it, and which account — is picked in the composer's Provider menu, as it
 * is on a session that is already running, and only there: the card names the engine alone.
 */
export function NewSessionProviderHero({
  current,
  engines,
  onPick,
  runnerId,
  disabled,
  note,
  currentModelLabel,
  projectIntent = false,
}: {
  /** The engine the draft runs on, landing on the provider it will spend. */
  current: EngineChoice;
  engines: EngineChoice[];
  /** An engine was picked: the provider of it to start on (`EngineChoice.provider`). */
  onPick: (provider: string) => void;
  /** The machine these engines live on — the sign-in link has to name it, since the Providers
   *  page lists every runner and only this one's row is the answer. */
  runnerId: string;
  /** A live/locked session has no choice to make; the hero then reads as a label. */
  disabled?: boolean;
  /** Transient line under the summary (what a switch just changed, and where it was saved). */
  note?: string | null;
  /** The model this draft will actually send with; engine rows carry the runner default instead. */
  currentModelLabel?: string;
  /** The Projects entry point still uses this same picker; only its framing copy changes. */
  projectIntent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const displayed = engines.some((engine) => engine.slug === current.slug) ? engines : [current, ...engines];

  // Naming the runner and the engine, so the Providers page can unfold that machine's card and
  // point at the row — where its Install and Sign in buttons are — instead of leaving the user to
  // find it among every runner they own. A problem that is not this machine's (an account pool none
  // of whose accounts can run) names its own page instead.
  const fixLink = (choice: Pick<ProviderChoice, 'slug' | 'fixEngine' | 'fixHref'>) =>
    choice.fixHref ?? `/providers?runner=${encodeId(runnerId)}&engine=${choice.fixEngine ?? choice.slug}`;
  const onRunner = (choice: Pick<ProviderChoice, 'fixHref'>) => (choice.fixHref ? '' : ' on this runner');
  const modelLabel = currentModelLabel ?? current.provider.modelLabel;
  const currentDetail = engineProviderDetail(current);
  const detail = (text?: string) => text && <small className="np-label-detail">{text}</small>;

  // An engine none of whose providers this runner can run can't start a session, so the row doesn't
  // pick it — it goes where the fix lives instead. The identity greys out (it isn't usable yet) while
  // the reason stays lit as the link it now is, so the row states the problem and offers the fix
  // rather than disappearing and leaving the absence to be explained.
  const row = (engine: EngineChoice) =>
    engine.unavailable ? (
      <Link
        key={engine.slug}
        to={fixLink(engine.provider)}
        className="np-row np-unavailable"
        title={`${engine.label}: ${engine.unavailable}${onRunner(engine.provider)} — fix it on the Providers page`}
        onClick={() => setOpen(false)}
      >
        <BrandMark choice={engine} size={20} />
        <span className="np-row-name">{engine.label}</span>
        <span className="np-row-model np-fix">{engine.unavailable}</span>
      </Link>
    ) : (
      <button
        key={engine.slug}
        type="button"
        className={`np-row${engine.slug === current.slug ? ' on' : ''}`}
        onClick={() => {
          setOpen(false);
          if (engine.provider.slug !== current.provider.slug) onPick(engine.provider.slug);
        }}
      >
        <BrandMark choice={engine} size={20} />
        <span className="np-row-name">{engine.label}{detail(engineProviderDetail(engine))}</span>
        <span className="np-row-model">{engine.provider.modelLabel}</span>
      </button>
    );

  const list = (
    <div className={`np-list${displayed.some((engine) => engineProviderDetail(engine)) ? ' with-details' : ''}`}>
      {displayed.map(row)}
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
      aria-label={`Engine: ${current.label}${currentDetail ? ` ${currentDetail}` : ''}`}
    >
      <BrandMark choice={current} size={56} />
      <span className="np-name">
        {current.label}
        {detail(currentDetail)}
        {!disabled && <span className="np-chev">▾</span>}
      </span>
    </button>
  );

  // The pick is sticky, so the current one can be a provider that machine can no longer run — and a
  // session started on it fails minutes later, at the runner. Say so here instead.
  const blocked = current.provider.unavailable ? current.provider : null;
  const fixSummary = blocked && (
    <div className="np-summary">
      <b>{blocked.label}</b>
      <span className="np-dot">·</span>
      {blocked.unavailable}
      {onRunner(blocked)}
      <span className="np-dot">·</span>
      <Link to={fixLink(blocked)}>Fix it</Link>
    </div>
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
      {fixSummary ??
        (projectIntent ? (
          <div className="np-summary">
            <b>{current.provider.label}</b>
            <span className="np-dot">·</span>
            {modelLabel}
            <span className="np-dot">·</span>
            <Link to="/providers">Manage</Link>
          </div>
        ) : (
          <>
            <div className="np-empty-copy">Send a task to get started.</div>
            <div className="np-current-model">{modelLabel}</div>
          </>
        ))}
      {note && <div className="np-note">{note}</div>}
    </div>
  );
}
