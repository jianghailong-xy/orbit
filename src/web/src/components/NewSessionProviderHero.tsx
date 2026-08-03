import { useState } from 'react';
import { Popover } from 'antd';
import { Link } from 'react-router-dom';
import { PROVIDER_GLYPHS } from '../lib/providerGlyphs';
import type { ProviderChoice } from '../lib/sessionProviderChoices';

/** The brand mark. Same construction as the /providers tile (gradient + white glyph), sized up:
 *  at hero size it carries a soft shadow in its own brand colour, which a 24px chip can't. */
function ProviderMark({ choice, size }: { choice: ProviderChoice; size: number }) {
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
 * opens on click, and the pick is remembered on the agent, so the common path is: read it, ignore
 * it, start typing.
 */
export function NewSessionProviderHero({
  current,
  choices,
  onPick,
  disabled,
  note,
}: {
  current: ProviderChoice;
  choices: ProviderChoice[];
  onPick: (slug: string) => void;
  /** A live/locked session has no choice to make; the hero then reads as a label. */
  disabled?: boolean;
  /** Transient line under the summary (what a switch just changed, and where it was saved). */
  note?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const engines = choices.filter((c) => c.kind === 'engine');
  const byok = choices.filter((c) => c.kind === 'byok');

  const row = (choice: ProviderChoice) => (
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

  const list = (
    <div className="np-list">
      <div className="np-group">Engines</div>
      {engines.map(row)}
      {byok.length > 0 && <div className="np-group">Your keys</div>}
      {byok.map(row)}
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
      <div className="np-title">Start a new session</div>
      <div className="np-sub">Describe the task — Orbit remembers who runs it.</div>
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
      <div className="np-summary">
        <b>{current.label}</b>
        <span className="np-dot">·</span>
        {current.modelLabel}
        <span className="np-dot">·</span>
        {current.kind === 'engine' ? 'runner login' : 'your API key'}
        <span className="np-dot">·</span>
        <Link to="/providers">Manage</Link>
      </div>
      {note && <div className="np-note">{note}</div>}
    </div>
  );
}
