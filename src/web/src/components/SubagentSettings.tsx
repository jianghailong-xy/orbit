import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { meQuery, type Me } from '../lib/queries';
import { providersCountText, subagentTiersQuery } from '../lib/subagentTiers';
import { useToast } from '../lib/toast';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { NumberInput } from './ui/NumberInput';
import { Segmented } from './ui/Segmented';
import { Switch } from './ui/Switch';

export type OptimizeFor = 'cost' | 'balance' | 'intelligence';

/** The most SubAgents of one session the owner can let run at once (workspaces/dto.ts SUBAGENTS_MAX_RUNNING_LIMIT). */
export const SUBAGENTS_MAX_RUNNING_LIMIT = 16;

/**
 * The Agent settings' SubAgents group (docs/subagent-design.md §7, board docs/mocks/subagent/05.png). The switch,
 * Optimize For and Running at once are the Agent's, saved with the form; Providers is the account's block list,
 * saved as it is changed.
 */
export function SubagentSettings({
  enabled,
  onEnabledChange,
  optimizeFor,
  onOptimizeForChange,
  maxRunning,
  onMaxRunningChange,
}: {
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  optimizeFor: OptimizeFor;
  onOptimizeForChange: (value: OptimizeFor) => void;
  maxRunning: number;
  onMaxRunningChange: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const me = useQuery(meQuery());
  const tiers = useQuery(subagentTiersQuery());
  const blocked = me.data?.preferences?.subagentBlockedProviders ?? [];
  const providers = tiers.data?.providers ?? [];
  return (
    <div className="subagents-group">
      <div className="rd-form-section">SubAgents</div>
      <div className="subagents-row">
        <div className="rd-set-main">
          <div className="rd-set-label">SubAgents</div>
          <div className="rd-set-desc">Let this agent hand work to other providers in the same folder</div>
        </div>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label="SubAgents" />
      </div>
      <div className="subagents-row">
        <div className="rd-set-main">
          <div className="rd-set-label">Optimize For</div>
        </div>
        <Segmented<OptimizeFor>
          aria-label="Optimize For"
          value={optimizeFor}
          onValueChange={onOptimizeForChange}
          options={[
            { value: 'cost', label: 'Cost' },
            { value: 'balance', label: 'Balance' },
            { value: 'intelligence', label: 'Intelligence' },
          ]}
        />
      </div>
      <div className="subagents-row">
        <div className="rd-set-main">
          <div className="rd-set-label">Providers</div>
          <div className="rd-set-desc">All enabled providers. Block one to keep SubAgents off it.</div>
        </div>
        <Button onClick={() => setEditing(true)} disabled={!tiers.isSuccess}>
          {providersCountText(providers, blocked)}
        </Button>
      </div>
      <div className="subagents-row">
        <div className="rd-set-main">
          <div className="rd-set-label">Running at once</div>
          <div className="rd-set-desc">Per session, foreground and background together</div>
        </div>
        <NumberInput
          aria-label="Running at once"
          value={maxRunning}
          min={1}
          max={SUBAGENTS_MAX_RUNNING_LIMIT}
          precision={0}
          style={{ width: 72 }}
          onValueChange={(value) => {
            if (value !== null) onMaxRunningChange(value);
          }}
        />
      </div>
      {editing && (
        <BlockedProviders
          providers={providers}
          blocked={blocked}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/** The account's SubAgents block list: every provider with a switch, on where SubAgents may use it. */
function BlockedProviders({
  providers,
  blocked,
  onClose,
}: {
  providers: readonly { slug: string; label: string }[];
  blocked: readonly string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (next: string[]) =>
      api<Me>('/users/me/preferences', { method: 'PATCH', body: { subagentBlockedProviders: next } }),
    onSuccess: (me) => qc.setQueryData(meQuery().queryKey, me),
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="SubAgent providers"
      description="SubAgents of every Agent on your account are routed only onto the providers switched on here."
      width={440}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="subagents-providers-list">
        {providers.map((provider) => (
          <label key={provider.slug}>
            <span>
              {provider.label}
              {provider.label !== provider.slug && <small>{provider.slug}</small>}
            </span>
            <Switch
              aria-label={provider.label}
              checked={!blocked.includes(provider.slug)}
              disabled={save.isPending}
              onCheckedChange={(on) =>
                save.mutate(on ? blocked.filter((slug) => slug !== provider.slug) : [...blocked, provider.slug])}
            />
          </label>
        ))}
      </div>
    </Dialog>
  );
}
