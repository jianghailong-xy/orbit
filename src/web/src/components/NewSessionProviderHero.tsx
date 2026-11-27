import { CheckOutlined, CodeOutlined, FolderOutlined } from '@ant-design/icons';
import { useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AgentProvider } from '@orbit/shared';
import { CLAUDE_REGION_DETAILS, CLAUDE_REGION_USE_ANOTHER_PROVIDER, anthropicUnavailableOn } from '../lib/claudeRegionCopy';
import { encodeId } from '../lib/idCodec';
import { PROVIDER_GLYPHS } from '../lib/providerGlyphs';
import { providerNameOn, type EngineChoice } from '../lib/sessionProviderChoices';
import { Popover } from './ui/Popover';
import { Tooltip } from './ui/Tooltip';

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
        // A near-black tile keeps an edge against a dark page (Antigravity's, and Cursor's cube).
        border: choice.glyphKey === 'antigravity' || choice.glyphKey === 'cursor-api' ? '1px solid rgba(255,255,255,0.16)' : undefined,
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

/** Where a new session will run: its workspace and, where the workspace has folders, its folder. */
export interface NewSessionPlace {
  workspace: { id: string; name: string };
  /** Every workspace a session can start in, in sidebar order. */
  workspaces: { id: string; name: string }[];
  onPickWorkspace: (id: string) => void;
  /** The folder the session starts in; null is none. */
  folder: { id: string; name: string } | null;
  /** This workspace's folders. With none, the line names the workspace alone. */
  folders: { id: string; name: string }[];
  onPickFolder: (id: string | null) => void;
}

/** Past this many rows the place menu gets a search box (docs/mocks/new-session-place ③). */
const PLACE_SEARCH_FROM = 9;

/** A component rather than a wrapped element, so the popover's trigger props reach the button through
 *  the tooltip. */
function PlaceButton({ place, label, ...props }: ComponentPropsWithRef<'button'> & { place: NewSessionPlace; label: string }) {
  return (
    <Tooltip content={label} truncatedOnly>
      <button {...props}>
        <CodeOutlined />
        <span className="np-place-name">{place.workspace.name}</span>
        {place.folder && (
          <>
            <span className="np-place-slash">/</span>
            <FolderOutlined />
            <span className="np-place-name">{place.folder.name}</span>
          </>
        )}
        <span className="np-chev">▾</span>
      </button>
    </Tooltip>
  );
}

/**
 * Under the engine (docs/mocks/new-session-place, option A): one bordered pill that says where the
 * session runs, `[workspace] / [folder] ▾`, naming the folder only when one is picked (a folder is a
 * sidebar group, so none is the quiet default rather than a "No folder" state). It opens one menu: the
 * workspaces, then this workspace's folders. A pick closes it: another workspace opens its own draft, whose
 * folders the menu lists once it is opened again.
 */
function PlacePill({ place }: { place: NewSessionPlace }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const label = place.folder ? `${place.workspace.name} / ${place.folder.name}` : place.workspace.name;
  const searchable = place.workspaces.length + place.folders.length + 1 >= PLACE_SEARCH_FROM;
  const needle = searchable ? query.trim().toLowerCase() : '';
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const workspaces = place.workspaces.filter((w) => matches(w.name));
  const folders = place.folders.filter((f) => matches(f.name));
  const row = (key: string, icon: ReactNode, name: string, on: boolean, pick: () => void) => (
    <button
      key={key}
      type="button"
      className={`np-row${on ? ' on' : ''}${icon ? '' : ' np-place-none'}`}
      data-row-focus=""
      onClick={() => {
        setOpen(false);
        setQuery('');
        if (!on) pick();
      }}
    >
      {icon}
      <span className="np-row-name">{name}</span>
      {on && <CheckOutlined className="np-place-check" />}
    </button>
  );
  return (
    <div className="np-place">
      <Popover
        title={null}
        trigger={
          <PlaceButton
            type="button"
            className={`np-place-pill${open ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Runs in: ${label}`}
            place={place}
            label={label}
          />
        }
        side="bottom"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
        arrow={false}
        popupClassName="np-pop"
      >
        <div className="np-list np-place-list">
          {searchable && (
            <input
              className="np-place-search"
              type="search"
              placeholder="Find a workspace or folder"
              aria-label="Find a workspace or folder"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {workspaces.length > 0 && <div className="np-place-head">Workspace</div>}
          {workspaces.map((w) =>
            row(w.id, <CodeOutlined />, w.name, w.id === place.workspace.id, () => place.onPickWorkspace(w.id)))}
          {place.folders.length > 0 && (!needle || folders.length > 0) && (
            <>
              {workspaces.length > 0 && <div className="np-sep" />}
              <div className="np-place-head">{`Folder in ${place.workspace.name} · optional`}</div>
              {!needle && row('none', null, 'None', !place.folder, () => place.onPickFolder(null))}
              {folders.map((f) =>
                row(f.id, <FolderOutlined />, f.name, f.id === place.folder?.id, () => place.onPickFolder(f.id)))}
            </>
          )}
          {workspaces.length === 0 && folders.length === 0 && <div className="np-place-empty">No matches</div>}
        </div>
      </Popover>
    </div>
  );
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
  fellBackFrom = null,
  machine,
  cantRun = false,
  place = null,
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
  /** What the workspace last ran on, when it can't run on this machine and the draft moved off it
   *  (draftFallback): the hero says what it uses instead, and why. */
  fellBackFrom?: EngineChoice | null;
  /** This machine's name, as the reasons above say it. */
  machine?: string;
  /** Nothing on this machine can run the draft: the send waits, and the hero offers the way out. */
  cantRun?: boolean;
  /** The model this draft will actually send with; engine rows carry the runner default instead. */
  currentModelLabel?: string;
  /** The Projects entry point still uses this same picker; only its framing copy changes. */
  projectIntent?: boolean;
  /** Where the session runs, said and picked under the engine; none before the workspace is known. */
  place?: NewSessionPlace | null;
}) {
  const [open, setOpen] = useState(false);
  const displayed = engines.some((engine) => engine.slug === current.slug) ? engines : [current, ...engines];

  // Naming the runner and the engine, so Infrastructure can unfold that machine's card and
  // point at the row — where its Install and Sign in buttons are — instead of leaving the user to
  // find it among every runner they own. A problem that is not this machine's (an account pool none
  // of whose accounts can run, a DeepSeek key not connected yet) names its own page instead.
  const fixLink = (choice: Pick<EngineChoice, 'slug' | 'fixEngine' | 'fixHref'>) =>
    choice.fixHref ?? `/settings/machines/${encodeId(runnerId)}?engine=${choice.fixEngine ?? choice.slug}`;
  const onRunner = (choice: Pick<EngineChoice, 'fixHref'>) => (choice.fixHref ? '' : ' on this runner');
  const modelLabel = currentModelLabel ?? current.provider?.modelLabel ?? '';

  // An engine none of whose credentials this runner can run can't start a session, so the row doesn't
  // pick it — it goes where the fix lives instead. The identity greys out (it isn't usable yet) while
  // the reason stays lit as the link it now is, so the row states the problem and offers the fix
  // rather than disappearing and leaving the absence to be explained.
  const row = (engine: EngineChoice) =>
    engine.unavailable || !engine.provider ? (
      <Tooltip key={engine.slug} content={`${engine.label}: ${engine.unavailable}${onRunner(engine)}${engine.regionBlocked ? '' : ' — fix it on the Machines & models page'}`}>
        <Link
          to={fixLink(engine)}
          className="np-row np-unavailable"
          data-row-focus=""
          onClick={() => setOpen(false)}
        >
          <BrandMark choice={engine} size={20} />
          <span className="np-row-name">{engine.label}</span>
          <span className="np-row-model np-fix">{engine.unavailable}</span>
        </Link>
      </Tooltip>
    ) : (
      <button
        key={engine.slug}
        type="button"
        className={`np-row${engine.slug === current.slug ? ' on' : ''}`}
        data-row-focus=""
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
      <Link to="/settings/providers/new" className="np-row np-connect" data-row-focus="" onClick={() => setOpen(false)}>
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
  // a session started on it fails minutes later, at the runner. Say so here instead. A reason nothing
  // on the page fixes — the runner's Claude region — links to its explanation rather than a fix.
  const blocked = current.provider?.unavailable ? current.provider : null;
  const fixSummary = blocked && (
    <div className="np-summary">
      <b>{providerNameOn(current.slug, blocked)}</b>
      <span className="np-dot">·</span>
      {blocked.unavailable}
      {onRunner(blocked)}
      <span className="np-dot">·</span>
      <Link to={fixLink({ slug: current.slug, fixEngine: blocked.fixEngine, fixHref: blocked.fixHref })}>
        {blocked.regionBlocked ? CLAUDE_REGION_DETAILS : 'Fix it'}
      </Link>
    </div>
  );

  // The draft moved off what the workspace last ran on (board docs/mocks/new-session-usable-default
  // ② ③): which credential it uses now, or which engine could not run, and why — said where the
  // default is read, so the move is never silent. The reason's link is the one the blocked line had.
  const from = fellBackFrom?.provider?.unavailable ? fellBackFrom.provider : null;
  // Only a reason this machine has names it (OrbitKit's `fallbackLine` says the same).
  const where = !from?.fixEngine ? '' : machine ? ` on ${machine}` : ' on this runner';
  const fallbackSummary = fellBackFrom && from && current.provider && (
    <div className="np-summary np-fallback">
      {fellBackFrom.slug === current.slug ? (
        <>
          <span>
            Using <b>{providerNameOn(current.slug, current.provider)}</b>
          </span>
          <span className="np-dot">·</span>
          {from.regionBlocked && machine
            ? anthropicUnavailableOn(machine)
            : `${providerNameOn(fellBackFrom.slug, from)}: ${from.unavailable}${where}`}
        </>
      ) : (
        <span>{`${fellBackFrom.label} can’t run${where}: ${from.unavailable}`}</span>
      )}
      <span className="np-dot">·</span>
      <Link to={fixLink({ slug: fellBackFrom.slug, fixEngine: from.fixEngine, fixHref: from.fixHref })}>
        {from.regionBlocked ? CLAUDE_REGION_DETAILS : 'Fix it'}
      </Link>
    </div>
  );
  // Nothing here runs it (board ④): another provider's key is the way out on this machine.
  const cantRunNote = cantRun && (
    <div className="np-cant-run">
      {machine ? `Nothing on ${machine} can run a session yet.` : 'Nothing on this runner can run a session yet.'}{' '}
      <Link to="/settings/providers">{CLAUDE_REGION_USE_ANOTHER_PROVIDER}</Link>
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
          title={null}
          trigger={card}
          side="bottom"
          open={open}
          onOpenChange={setOpen}
          arrow={false}
          popupClassName="np-pop"
        >
          {list}
        </Popover>
      )}
      {place && <PlacePill place={place} />}
      {fixSummary ??
        fallbackSummary ??
        (projectIntent ? (
          <div className="np-summary">
            <b>{current.provider ? providerNameOn(current.slug, current.provider) : current.label}</b>
            <span className="np-dot">·</span>
            {modelLabel}
            <span className="np-dot">·</span>
            <Link to={`/settings/machines/${encodeId(runnerId)}`}>Manage</Link>
          </div>
        ) : (
          // The model is said once, in the composer, where it is changed (docs/mocks/new-session-top ③).
          <div className="np-empty-copy">Send a task to get started.</div>
        ))}
      {cantRunNote}
      {note && <div className="np-note">{note}</div>}
    </div>
  );
}
