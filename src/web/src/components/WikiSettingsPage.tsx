import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExclamationCircleOutlined, RightOutlined } from '@ant-design/icons';
import {
  wikiSpaceSettings,
  type WikiMaintenanceSettings,
  type WikiReviewMode,
  type WikiSystemModelStatus,
} from '@orbit/shared';
import { wikiHealthQuery, wikiSpacesQuery, wikiSpaceWorkspacesQuery, wikiSystemModelQuery, workspacesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { WIKI_PATH, WIKI_SETTINGS_SAVED, WIKI_TITLE, wikiSpacePath, type WikiSpaceRow } from '../lib/wiki';
import { wikiSpaceNames } from '../lib/wikiSpace';
import {
  WIKI_DAILY_LIMIT,
  WIKI_DEFAULT_REVIEW_MODE,
  WIKI_FLOORS_LEAD,
  WIKI_FLOORS_NOTE,
  WIKI_LOOKBACK,
  WIKI_MAINTENANCE,
  WIKI_MAINTENANCE_EDIT,
  WIKI_MAINTENANCE_NAME,
  WIKI_MAINTENANCE_NOTE_SERVER,
  WIKI_MODE_DEFAULT,
  WIKI_MODE_LABELS,
  WIKI_MODE_NOTES,
  WIKI_MODE_ORDER,
  WIKI_MODEL,
  WIKI_OFF,
  WIKI_ON,
  WIKI_ADD_WORKSPACE,
  WIKI_ADD_WORKSPACE_GROUP,
  WIKI_REPO_FROM,
  WIKI_REVIEW_MODE,
  WIKI_REVIEW_MODE_HINT,
  WIKI_REVIEW_MODE_LEAD,
  WIKI_SETTINGS,
  WIKI_SETTINGS_TITLE,
  WIKI_SET_UP,
  WIKI_SPOT_CHECK,
  WIKI_SPOT_CHECK_NOTE,
  WIKI_STATUS,
  WIKI_TURN_OFF,
  wikiLookbackLabel,
  wikiModeFallback,
  wikiRunsADay,
  WIKI_TRASH_NOTE,
  WIKI_TRASH_OPEN,
  WIKI_TRASH_TITLE,
  wikiTrashHolds,
  WIKI_WORKSPACE_LEFT_OUT,
  WIKI_WORKSPACES,
  WIKI_WORKSPACES_EMPTY,
  WIKI_WORKSPACES_JOIN,
  WIKI_WORKSPACES_JOIN_NO_REPOSITORY,
  WIKI_WORKSPACES_LEAD,
  wikiWorkspaceLabel,
} from '../lib/wikiReviewMode';
import { addWikiWorkspace, leaveWikiWorkspaceOut, runWikiMaintenanceNow, updateWikiSpace, useWikiWrite, type WikiSpaceUpdate } from '../lib/wikiWrites';
import {
  WIKI_CHANGE_WORKSPACE,
  WIKI_CHECK_AND_RUN,
  WIKI_RUN_REFUSED,
  WIKI_RUN_STARTED,
  WIKI_USE_FOLDER,
  WIKI_USE_FOLDER_NOTE,
  WIKI_USE_FOLDER_TITLE,
  wikiRepoCard,
} from '../lib/wikiRepoCard';
import { useConfirm } from './ui/ConfirmDialog';
import { WikiTrashLink, useMoveWikiToTrash } from './WikiTrashDialog';
import { WikiModelLine, WikiPrivacyNote } from './WikiSystemModel';
import { WikiSetUpDialog } from './WikiSetUpDialog';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Menu } from './ui/Menu';
import { Radio, RadioGroup } from './ui/Radio';
import { Switch } from './ui/Switch';

/**
 * Wiki settings (criterion 8, mocks 19–20): which review mode the space runs in, whether Automatic
 * sends spot checks, and the space's Wiki maintenance run.
 *
 * THE APP'S OWN SETTINGS PAGE, not a new one: one centred column of the app's cards, a sentence on the
 * left and its control on the right (`SettingsPage.tsx`). What differs is only that these settings
 * belong to one space, which is why the page lives under `/wiki/:space`.
 *
 * EVERY CONTROL WRITES AT ONCE, through the owner's door (`PATCH /wiki/spaces/:id`), which refuses any
 * request that carries a session header — the mode that decides what an agent's writes do is never an
 * agent's to set. The page then reads the space again, so what it shows is what the server kept.
 *
 * THE SERVER EXECUTES THE WIKI (mock 35 ①②), so there is no provider to pick: the workspace is where the repository
 * is read from, and while `GET /wiki/system-model`'s `executor` says the server executes the account's wiki,
 * maintenance names the deployment's System model, read-only with its state, and one sentence says where the
 * wiki's material goes. A read that does not say so — still loading, or a control plane from before it — draws
 * neither.
 */
export function WikiSettingsPage({ space }: { space: WikiSpaceRow }) {
  const settings = wikiSpaceSettings(space.settings);
  const toast = useToast();
  const write = useWikiWrite((body: WikiSpaceUpdate) => updateWikiSpace(space.id, body));
  const [setUp, setSetUp] = useState(false);

  const save = async (body: WikiSpaceUpdate) => {
    try {
      await write.mutateAsync(body);
      toast.success(WIKI_SETTINGS_SAVED);
    } catch (error) {
      toast.error("Couldn't save the wiki settings", error instanceof Error ? error.message : undefined);
    }
  };

  const fallback = wikiModeFallback(settings);
  const mode = settings.reviewMode;
  const systemModel = useQuery(wikiSystemModelQuery());
  const server = systemModel.data?.executor?.serverExecutes ? systemModel.data : null;

  return (
    <div className="wk-settings">
      <div className="wk-crumb">
        <Link to={wikiSpacePath(space.slug)}>{WIKI_TITLE}</Link>
        <RightOutlined className="ic" />
        <span>{WIKI_SETTINGS}</span>
      </div>
      <h1 className="page-title">{WIKI_SETTINGS_TITLE}</h1>
      <div className="wk-settings-sub">
        {space.slug}
        {space.repoUrlNorm ? ` · ${space.repoUrlNorm}` : ''}
      </div>

      <Card
        className="wk-settings-card"
        title={WIKI_REVIEW_MODE}
        extra={<span className="wk-settings-hint">{WIKI_REVIEW_MODE_HINT}</span>}
      >
        {fallback && (
          <div className="wk-warn" role="status">
            <ExclamationCircleOutlined className="ic" />
            <span>{fallback}</span>
          </div>
        )}
        <div className="wk-settings-lead">{WIKI_REVIEW_MODE_LEAD}</div>
        <RadioGroup
          className="wk-modes"
          value={mode}
          disabled={write.isPending}
          onValueChange={(value) => void save({ reviewMode: value as WikiReviewMode })}
        >
          {WIKI_MODE_ORDER.map((value) => (
            <div className={`wk-mode${value === mode ? ' on' : ''}`} key={value}>
              <Radio value={value}>
                <span className="wk-mode-t">{WIKI_MODE_LABELS[value]}</span>
                {value === WIKI_DEFAULT_REVIEW_MODE && <span className="wk-mode-tag">{WIKI_MODE_DEFAULT}</span>}
              </Radio>
              <div className="wk-mode-d">{WIKI_MODE_NOTES[value]}</div>
              {value === 'automatic' && (
                <div className={`wk-spot${mode === 'automatic' ? '' : ' off'}`}>
                  <div>
                    <div className="wk-spot-t">{WIKI_SPOT_CHECK}</div>
                    <div className="wk-spot-d">{WIKI_SPOT_CHECK_NOTE}</div>
                  </div>
                  <Switch
                    aria-label={WIKI_SPOT_CHECK}
                    checked={settings.automaticSpotChecks}
                    disabled={mode !== 'automatic' || write.isPending}
                    onCheckedChange={(checked) => void save({ automaticSpotChecks: checked })}
                  />
                </div>
              )}
            </div>
          ))}
        </RadioGroup>
        <div className="aa-ask wk-floors">
          <b>{WIKI_FLOORS_LEAD}</b> {WIKI_FLOORS_NOTE}
        </div>
      </Card>

      <WikiWorkspacesCard space={space} />

      <Card className="wk-settings-card" title={<MaintenanceTitle space={space} />}>
        {settings.maintenance.enabled ? (
          <MaintenanceOn
            space={space}
            maintenance={settings.maintenance}
            server={server}
            busy={write.isPending}
            onEdit={() => setSetUp(true)}
            onTurnOff={() => void save({ maintenance: { enabled: false } })}
          />
        ) : (
          <>
            <div className="wk-maint-off">
              <div>
                <div className="wk-maint-t">{WIKI_MAINTENANCE_NAME}</div>
                <div className="wk-maint-d">{WIKI_MAINTENANCE_NOTE_SERVER}</div>
              </div>
              <span className="wk-maint-state">
                <span className="wk-dot proposed" aria-hidden="true" /> {WIKI_OFF}
              </span>
              <Button onClick={() => setSetUp(true)}>{WIKI_SET_UP}</Button>
            </div>
            {server && <WikiPrivacyNote />}
          </>
        )}
      </Card>

      <WikiTrashCard space={space} />

      {setUp && (
        <WikiSetUpDialog space={space} onClose={() => setSetUp(false)} />
      )}
    </div>
  );
}

/**
 * The last card of the page (docs/mocks/wiki-trash): it asks first, as nothing else on this page does, and under it the
 * way to Trash while anything is in it.
 */
function WikiTrashCard({ space }: { space: WikiSpaceRow }) {
  const navigate = useNavigate();
  const spaces = useQuery(wikiSpacesQuery());
  const [ask, confirmation] = useMoveWikiToTrash(() => navigate(WIKI_PATH));
  const name = wikiSpaceNames(spaces.data ?? []).get(space.id) ?? space.title;
  return (
    <Card className="wk-settings-card" title={WIKI_TRASH_TITLE}>
      <div className="wk-delete">
        <div className="wk-maint-d">{WIKI_TRASH_NOTE}</div>
        <Button danger onClick={() => ask(space, name)}>{WIKI_TRASH_OPEN}</Button>
      </div>
      <WikiTrashLink sentence={wikiTrashHolds} className="wk-trash-link-card" />
      {confirmation}
    </Card>
  );
}

/**
 * The Workspaces card (mock 38, contract `space.workspaces`): the workspaces in this wiki, each with its switch, and
 * the ones with no repository that can be added. Like every control here it writes at once; a row stays on the list
 * when it is turned off, and the list goes by name, so nothing moves under the pointer.
 */
function WikiWorkspacesCard({ space }: { space: WikiSpaceRow }) {
  const toast = useToast();
  const listed = useQuery(wikiSpaceWorkspacesQuery(space.id));
  const write = useWikiWrite(({ workspaceId, inWiki }: { workspaceId: string; inWiki: boolean }) =>
    inWiki ? addWikiWorkspace(space.id, workspaceId) : leaveWikiWorkspaceOut(space.id, workspaceId),
  );

  const change = async (workspaceId: string, inWiki: boolean) => {
    try {
      await write.mutateAsync({ workspaceId, inWiki });
      toast.success(WIKI_SETTINGS_SAVED);
    } catch (error) {
      toast.error("Couldn't save the wiki settings", error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <Card className="wk-settings-card" title={WIKI_WORKSPACES}>
      <div className="wk-settings-lead">{WIKI_WORKSPACES_LEAD}</div>
      {listed.data && (
        <>
          {listed.data.workspaces.length === 0 ? (
            <div className="wk-ws-empty">{WIKI_WORKSPACES_EMPTY}</div>
          ) : (
            <div className="wk-ws-list">
              {listed.data.workspaces.map((row) => (
                <div className={`wk-ws-row${row.inWiki ? '' : ' off'}`} key={row.id}>
                  <div className="wk-ws-tx">
                    <div className="wk-ws-t">
                      {row.name}
                      {row.runner && <span className="dim"> · {row.runner}</span>}
                    </div>
                    {!row.inWiki && <div className="wk-ws-d">{WIKI_WORKSPACE_LEFT_OUT}</div>}
                  </div>
                  <Switch
                    aria-label={row.name}
                    checked={row.inWiki}
                    disabled={write.isPending}
                    onCheckedChange={(inWiki) => void change(row.id, inWiki)}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="wk-ws-foot">
            <div className="wk-ws-note">{space.repoUrlNorm ? WIKI_WORKSPACES_JOIN : WIKI_WORKSPACES_JOIN_NO_REPOSITORY}</div>
            {listed.data.addable.length > 0 && (
              <Menu
                align="end"
                disabled={write.isPending}
                trigger={<Button>{WIKI_ADD_WORKSPACE}</Button>}
                items={[{
                  type: 'group',
                  key: 'addable',
                  label: WIKI_ADD_WORKSPACE_GROUP,
                  children: listed.data.addable.map((row) => ({
                    key: row.id,
                    label: row.runner ? `${row.name} · ${row.runner}` : row.name,
                    onSelect: () => void change(row.id, true),
                  })),
                }]}
              />
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/** The card's title, and beside it the tag of what the last run read when that is less than git (mock 44 ⑤). */
function MaintenanceTitle({ space }: { space: WikiSpaceRow }) {
  const health = useQuery(wikiHealthQuery(space.id));
  const card = health.data ? wikiRepoCard(health.data, Date.now()) : null;
  return (
    <>
      {WIKI_MAINTENANCE}
      {card && <span className={`wk-repo-tag ${card.tag.tone}`}>{card.tag.text}</span>}
    </>
  );
}

/**
 * What the last run read and the ways to set it right (docs/wiki-repo-tiers-design.md §7.3, mock 44 ⑤): the sentence and
 * when it was checked, then Check again and run now — off with its reason when the day is used up or a run is under way —
 * Change workspace…, which opens the same form as Edit, and Use this folder when the folder was refused for sharing too
 * few files with the last snapshot, asked once.
 */
function MaintenanceRepo({ space, onChange }: { space: WikiSpaceRow; onChange: () => void }) {
  const toast = useToast();
  const health = useQuery(wikiHealthQuery(space.id));
  const run = useWikiWrite((acceptFolder: boolean) => runWikiMaintenanceNow(space.id, acceptFolder));
  const [confirm, holder] = useConfirm();
  const card = health.data ? wikiRepoCard(health.data, Date.now()) : null;
  if (!card) return null;
  const start = async (acceptFolder: boolean) => {
    try {
      await run.mutateAsync(acceptFolder);
      toast.success(WIKI_RUN_STARTED);
    } catch (error) {
      toast.error(WIKI_RUN_REFUSED, error instanceof Error ? error.message : undefined);
    }
  };
  return (
    <div className="wk-repo-card">
      <div className="wk-repo-line">{card.line}</div>
      <div className="wk-repo-actions">
        <Button variant="primary" disabled={!card.canRun} loading={run.isPending} onClick={() => void start(false)}>
          {WIKI_CHECK_AND_RUN}
        </Button>
        <Button onClick={onChange}>{WIKI_CHANGE_WORKSPACE}</Button>
        {card.useFolder && (
          <Button
            disabled={!card.canRun || run.isPending}
            onClick={() => void confirm({
              title: WIKI_USE_FOLDER_TITLE,
              description: WIKI_USE_FOLDER_NOTE,
              confirmText: WIKI_USE_FOLDER,
              onConfirm: () => start(true),
            })}
          >
            {WIKI_USE_FOLDER}
          </Button>
        )}
      </div>
      {card.blocked && <div className="wk-repo-blocked">{card.blocked}</div>}
      {holder}
    </div>
  );
}

/**
 * Maintenance once it is on: where it reads the repository from, the System model, and how often it may — then
 * Edit and Turn off, with the privacy note.
 */
function MaintenanceOn({
  space,
  maintenance,
  server,
  busy,
  onEdit,
  onTurnOff,
}: {
  space: WikiSpaceRow;
  maintenance: WikiMaintenanceSettings;
  server: WikiSystemModelStatus | null;
  busy: boolean;
  onEdit: () => void;
  onTurnOff: () => void;
}) {
  const workspaces = useQuery(workspacesQuery());
  const workspace = (workspaces.data ?? []).find((row) => row.id === maintenance.workspaceId);
  const where = workspace ? wikiWorkspaceLabel(workspace) : (maintenance.workspaceId ?? '—');
  return (
    <>
      <MaintenanceRepo space={space} onChange={onEdit} />
      <div className="wk-maint-rows">
        <span className="k">{WIKI_STATUS}</span>
        <span className="v">
          <span className="wk-dot on" aria-hidden="true" /> {WIKI_ON}
        </span>
        <span className="k">{WIKI_REPO_FROM}</span>
        <span className="v">{where}</span>
        {server && (
          <>
            <span className="k">{WIKI_MODEL}</span>
            <span className="v">
              <WikiModelLine model={server} />
            </span>
          </>
        )}
        <span className="k">{WIKI_DAILY_LIMIT}</span>
        <span className="v">{wikiRunsADay(maintenance.dailyRunLimit)}</span>
        <span className="k">{WIKI_LOOKBACK}</span>
        <span className="v">{wikiLookbackLabel(maintenance.lookbackDays)}</span>
      </div>
      {server && <WikiPrivacyNote />}
      <div className="wk-maint-foot">
        <Button onClick={onEdit} disabled={busy}>
          {WIKI_MAINTENANCE_EDIT}
        </Button>
        <Button variant="text" danger onClick={onTurnOff} disabled={busy}>
          {WIKI_TURN_OFF}
        </Button>
      </div>
    </>
  );
}
