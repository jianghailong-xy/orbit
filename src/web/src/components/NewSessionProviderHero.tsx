import { useState } from 'react';
import { Popover } from 'antd';
import { Link } from 'react-router-dom';
import type { AgentProvider } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { PROVIDER_GLYPHS } from '../lib/providerGlyphs';
import { providerNameOn, type EngineChoice } from '../lib/sessionProviderChoices';

/** The brand mark. Same artwork and tile as /providers, sized up: at hero size it carries a soft
 *  shadow in its own brand colour, which a 20px row chip can't. The composer's Provider menu draws
 *  its keys' and pools' vendor marks with it too. */
export function BrandMark({ choice, size }: { choice: Pick<EngineChoice, 'brand' | 'glyphKey'>; size: number }) {
  const glyph = choice.glyphKey ? PROVIDER_GLYPHS[choice.glyphKey] : undefined;
  return (
    <span
      className="provider-tile np-mark"
      // Decorative: the name beside it says the same thing.
      aria-hidden="true"
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
 * The New Session middle area: which engine runs this session — fixed for its life once it starts.
 *
 * Collapsed to a single identity by default — the engine is a sticky choice, so showing every
 * option on every new session would charge the full visual cost for the rare switch. The list
 * opens on click, and the pick is remembered on the workspace, so the common path is: read it, ignore
 * it, start typing. Which credential the engine spends — its own sign-in, an account pool, a key it
 * runs, and which account — is picked in the composer's Provider menu, as it is on a session that is
 * already running, and only there: the card names the engine alone.
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
  /** Another engine was picked, with the provider of it to start on (`EngineChoice.provider`). */
  onPick: (engine: AgentProvider, provider: string) => void;
  /** The machine these engines live on — the sign-in link has to name it, since Infrastructure
   *  lists every machine and only this one's row is the answer. */
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

  // Naming the runner and the engine, so Infrastructure can unfold that machine's card and
  // point at the row — where its Install and Sign in buttons are — instead of leaving the user to
  // find it among every runner they own. A problem that is not this machine's (an account pool none
  // of whose accounts can run, a DeepSeek key not connected yet) names its own page instead.
  const fixLink = (choice: Pick<EngineChoice, 'slug' | 'fixEngine' | 'fixHref'>) =>
    choice.fixHref ?? `/infrastructure?runner=${encodeId(runnerId)}&engine=${choice.fixEngine ?? choice.slug}`;
  const onRunner = (choice: Pick<EngineChoice, 'fixHref'>) => (choice.fixHref ? '' : ' on this runner');
  const modelLabel = currentModelLabel ?? current.provider?.modelLabel ?? '';

  // An engine none of whose credentials this runner can run can't start a session, so the row doesn't
  // pick it — it goes where the fix lives instead. The identity greys out (it isn't usable yet) while
  // the reason stays lit as the link it now is, so the row states the problem and offers the fix
  // rather than disappearing and leaving the absence to be explained.
  const row = (engine: EngineChoice) =>
    engine.unavailable || !engine.provider ? (
      <Link
        key={engine.slug}
        to={fixLink(engine)}
        className="np-row np-unavailable"
        title={`${engine.label}: ${engine.unavailable}${onRunner(engine)} — fix it in Infrastructure`}
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
          if (engine.slug !== current.slug && engine.provider) onPick(engine.slug, engine.provider.slug);
        }}
      >
        <BrandMark choice={engine} size={20} />
        <span className="np-row-name">{engine.label}</span>
        <span className="np-row-model">{engine.provider.modelLabel}</span>
      </button>
    );

  const list = (
    <div className="np-list">
      {displayed.map(row)}
      <div className="np-sep" />
      <Link to="/infrastructure" className="np-row np-connect" onClick={() => setOpen(false)}>
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
      aria-label={`Engine: ${current.label}`}
    >
      <BrandMark choice={current} size={56} />
      <span className="np-name">
        {current.label}
        {!disabled && <span className="np-chev">▾</span>}
      </span>
    </button>
  );

  // The pick is sticky, so the current one can be a credential that machine can no longer run — and
  // a session started on it fails minutes later, at the runner. Say so here instead.
  const blocked = current.provider?.unavailable ? current.provider : null;
  const fixSummary = blocked && (
    <div className="np-summary">
      <b>{providerNameOn(current.slug, blocked)}</b>
      <span className="np-dot">·</span>
      {blocked.unavailable}
      {onRunner(blocked)}
      <span className="np-dot">·</span>
      <Link to={fixLink({ slug: current.slug, fixEngine: blocked.fixEngine, fixHref: blocked.fixHref })}>Fix it</Link>
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
            <b>{current.provider ? providerNameOn(current.slug, current.provider) : current.label}</b>
            <span className="np-dot">·</span>
            {modelLabel}
            <span className="np-dot">·</span>
            <Link to="/infrastructure">Manage</Link>
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
