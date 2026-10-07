import { useState } from 'react';
import { Alert, Button, Checkbox, Input, Modal, Radio, Select } from 'antd';
import type { AccessTokenLifetime } from '../api';
import {
  DEFAULT_EXPIRY,
  EXPIRY_OPTIONS,
  NEVER_EXPIRES_WARNING,
  SCOPE_GROUPS,
  SCOPE_PRESETS,
  type ScopePreset,
  fullDate,
  scopesOfPreset,
} from '../lib/accessTokens';

const DAY_MS = 86_400_000;

/** What the dialog asks the server to issue. */
export interface NewAccessToken {
  name: string;
  scopes: string[];
  workspaceIds: string[];
  expiresInDays: AccessTokenLifetime;
}

/**
 * Settings → Access tokens → New token (docs/personal-access-token-design.md §9): a name; what the
 * token can do — read-only, read & write, or a pick resource by resource; which workspaces it is
 * confined to, if any; and how long it lives — 30, 90 or 365 days, or never, 90 unless another is
 * chosen. Choosing never says what it risks right there. The form starts over each time it opens.
 */
export function NewAccessTokenDialog({
  open,
  onClose,
  onCreate,
  creating,
  workspaces,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (token: NewAccessToken) => void;
  creating: boolean;
  workspaces: readonly { id: string; name: string }[];
}) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="New access token"
      footer={null}
      width={560}
      destroyOnHidden
      className="access-token-dialog"
    >
      <NewTokenForm onClose={onClose} onCreate={onCreate} creating={creating} workspaces={workspaces} />
    </Modal>
  );
}

function NewTokenForm({
  onClose,
  onCreate,
  creating,
  workspaces,
}: {
  onClose: () => void;
  onCreate: (token: NewAccessToken) => void;
  creating: boolean;
  workspaces: readonly { id: string; name: string }[];
}) {
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<ScopePreset>('read');
  const [picked, setPicked] = useState<string[]>([]);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY);
  const scopes = preset === 'custom' ? picked : scopesOfPreset(preset);
  const lifetime = EXPIRY_OPTIONS.find((option) => option.value === expiry)!.days;
  const canCreate = name.trim() !== '' && scopes.length > 0;

  const choosePreset = (next: ScopePreset) => {
    // Custom starts from what the preset it leaves granted.
    if (next === 'custom') setPicked(scopes);
    setPreset(next);
  };
  // Writing a resource needs reading it to be of use, so the two move together: write brings read
  // along, and giving up read gives up write.
  const toggle = (scope: string, on: boolean) => {
    const group = SCOPE_GROUPS.find((g) => g.read === scope || g.write === scope)!;
    setPicked((current) => {
      if (on) return [...new Set([...current, scope, group.read])];
      return current.filter((s) => s !== scope && !(scope === group.read && s === group.write));
    });
  };
  const create = () =>
    canCreate && onCreate({ name: name.trim(), scopes, workspaceIds, expiresInDays: lifetime });

  return (
    <div className="access-token-form">
      <label className="access-token-field">
        <span className="access-token-label">Name</span>
        <Input
          value={name}
          maxLength={100}
          placeholder="What it’s for, e.g. Nightly report script"
          onChange={(event) => setName(event.target.value)}
          onPressEnter={create}
          autoFocus
        />
      </label>

      <div className="access-token-field">
        <span className="access-token-label" id="access-token-access">
          Access
        </span>
        <Radio.Group
          aria-labelledby="access-token-access"
          optionType="button"
          value={preset}
          options={SCOPE_PRESETS.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(event) => choosePreset(event.target.value as ScopePreset)}
        />
        {preset === 'custom' ? (
          <div className="access-token-scopes" role="group" aria-label="Scopes">
            {SCOPE_GROUPS.map((group) => (
              <div key={group.resource} className="access-token-scope-row">
                <span>{group.resource}</span>
                <Checkbox checked={picked.includes(group.read)} onChange={(event) => toggle(group.read, event.target.checked)}>
                  Read
                </Checkbox>
                {group.write ? (
                  <Checkbox
                    checked={picked.includes(group.write)}
                    onChange={(event) => toggle(group.write!, event.target.checked)}
                  >
                    Write
                  </Checkbox>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="access-token-help">
            {preset === 'read'
              ? 'Reads tasks, projects, sessions, workspaces, runners, the wiki and live events. Changes nothing.'
              : 'Reads and changes tasks, projects, sessions, workspaces and the wiki, and reads runners and live events.'}
          </div>
        )}
        <div className="access-token-help">
          No token can confirm, approve or decide anything for you — those stay with you, signed in to Orbit.
        </div>
      </div>

      <div className="access-token-field">
        <span className="access-token-label" id="access-token-workspaces">
          Workspaces
        </span>
        <Select
          aria-labelledby="access-token-workspaces"
          mode="multiple"
          allowClear
          placeholder="All workspaces"
          value={workspaceIds}
          onChange={setWorkspaceIds}
          optionFilterProp="label"
          options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
        />
        <div className="access-token-help">
          Leave empty for all of them. A token limited to workspaces reaches only their tasks, their sessions and the
          workspaces themselves.
        </div>
      </div>

      <div className="access-token-field">
        <span className="access-token-label" id="access-token-expiry">
          Expires
        </span>
        <Radio.Group
          aria-labelledby="access-token-expiry"
          optionType="button"
          value={expiry}
          options={EXPIRY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(event) => setExpiry(event.target.value as string)}
        />
        {lifetime === null ? (
          <Alert type="warning" showIcon className="access-token-never-warning" message={NEVER_EXPIRES_WARNING} />
        ) : (
          <div className="access-token-help">
            Stops working on {fullDate(new Date(Date.now() + lifetime * DAY_MS).toISOString())}.
          </div>
        )}
      </div>

      <div className="access-token-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="primary" disabled={!canCreate} loading={creating} onClick={create}>
          Create token
        </Button>
      </div>
    </div>
  );
}
