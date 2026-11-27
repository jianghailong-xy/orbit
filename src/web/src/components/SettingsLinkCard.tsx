import { useContext, type JSX } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { PublicLinkResolverCtx } from '../lib/publicLinks';
import { SETTINGS_CHANGE_COPY as COPY, settingPathLabel, type SettingPlace } from '../lib/settingsChange';
import { AppLink } from './AppLink';
import './SettingsChange.css';

/**
 * An `orbit-settings:<key>` link in an agent's words, drawn as the Open in Settings card (docs/settings-from-conversation
 * -design.md §6, board 2 frame ③): the setting's title, where it is, and a button that opens that page, scrolls to the
 * row and flashes it — the same `state.settingsAnchor` a Settings search result opens a page with (SettingsLayout).
 *
 * Drawn in spans, since the link sits in a paragraph. Outside a router (a transcript export) the button is a plain
 * link to the page; on a public page, where the reader has no Settings, it is the setting's name alone.
 */
export function SettingsLinkCard({ place }: { place: SettingPlace }): JSX.Element {
  const inRouter = useInRouterContext();
  const isPublic = useContext(PublicLinkResolverCtx) !== null;
  if (isPublic) return <strong>{place.title}</strong>;
  return (
    <span className="settings-link-card" data-settings-link={place.anchor}>
      <span className="settings-link-card-text">
        <span className="settings-link-card-title">{place.title}</span>
        <span className="settings-link-card-path">{settingPathLabel(place)}</span>
      </span>
      {inRouter ? <OpenButton place={place} /> : (
        <AppLink className="settings-link-card-open" to={place.path}>{COPY.openInSettings}</AppLink>
      )}
    </span>
  );
}

function OpenButton({ place }: { place: SettingPlace }): JSX.Element {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="settings-link-card-open"
      onClick={() => navigate(place.path, { state: { settingsAnchor: place.anchor } })}
    >
      {COPY.openInSettings}
    </button>
  );
}
