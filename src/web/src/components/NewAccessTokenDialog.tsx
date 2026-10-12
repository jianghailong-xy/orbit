import { useRef, useState, type RefObject } from 'react';
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
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Checkbox } from './ui/Checkbox';
import { Dialog } from './ui/Dialog';
import { Input } from './ui/Input';
import { MultiSelect } from './ui/MultiSelect';
import { Radio, RadioGroup } from './ui/Radio';

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
  // The name is where typing starts.
  const name = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onClose={onClose} title="New access token" width={560} initialFocus={name} className="access-token-dialog">
      <NewTokenForm nameRef={name} onClose={onClose} onCreate={onCreate} creating={creating} workspaces={workspaces} />
    </Dialog>
  );
}

function NewTokenForm({
  nameRef,
  onClose,
  onCreate,
  creating,
  workspaces,
}: {
  nameRef: RefObject<HTMLInputElement | null>;
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
          ref={nameRef}
          value={name}
          maxLength={100}
          placeholder="What it’s for, e.g. Nightly report script"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.repeat && !event.nativeEvent.isComposing) create();
          }}
        />
      </label>

      <div className="access-token-field">
        <span className="access-token-label" id="access-token-access">
          Access
        </span>
        <RadioGroup<ScopePreset> aria-labelledby="access-token-access" variant="button" value={preset} onValueChange={choosePreset}>
          {SCOPE_PRESETS.map((option) => (
            <Radio key={option.value} value={option.value}>
              {option.label}
            </Radio>
          ))}
        </RadioGroup>
        {preset === 'custom' ? (
          <div className="access-token-scopes" role="group" aria-label="Scopes">
            {SCOPE_GROUPS.map((group) => (
              <div key={group.resource} className="access-token-scope-row">
                <span>{group.resource}</span>
                <Checkbox checked={picked.includes(group.read)} onCheckedChange={(on) => toggle(group.read, on)}>
                  Read
                </Checkbox>
                {group.write ? (
                  <Checkbox checked={picked.includes(group.write)} onCheckedChange={(on) => toggle(group.write!, on)}>
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
        <MultiSelect
          aria-labelledby="access-token-workspaces"
          clearable
          placeholder="All workspaces"
          value={workspaceIds}
          onValueChange={setWorkspaceIds}
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
        <RadioGroup<string> aria-labelledby="access-token-expiry" variant="button" value={expiry} onValueChange={setExpiry}>
          {EXPIRY_OPTIONS.map((option) => (
            <Radio key={option.value} value={option.value}>
              {option.label}
            </Radio>
          ))}
        </RadioGroup>
        {lifetime === null ? (
          <Alert type="warning" className="access-token-never-warning" title={NEVER_EXPIRES_WARNING} />
        ) : (
          <div className="access-token-help">
            Stops working on {fullDate(new Date(Date.now() + lifetime * DAY_MS).toISOString())}.
          </div>
        )}
      </div>

      <div className="access-token-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canCreate} loading={creating} onClick={create}>
          Create token
        </Button>
      </div>
    </div>
  );
}
