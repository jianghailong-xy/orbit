import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { GrantsTable, useEndGrant } from '../../pages/SecretsPage';
import { grantView, isLive, secretGrantsQuery } from '../../lib/accountSecrets';
import { SettingsSection } from './SettingsBlocks';

/**
 * A machine page's "Secrets on this machine": Settings → Secrets' On machines now table, filtered to this runner,
 * with the same Revoke and Cancel. Renders nothing while the runner has no copy, live or removed in the last 30 days.
 */
export function MachineSecrets({ runnerId }: { runnerId: string }) {
  const grantsQ = useQuery(secretGrantsQuery());
  const revoke = useEndGrant();
  const [showRemoved, setShowRemoved] = useState(false);
  const mine = (grantsQ.data?.grants ?? []).filter((grant) => grant.runner.id === runnerId);
  if (mine.length === 0) return null;
  // As on Settings → Secrets: removed copies wait behind the toggle, except one whose removal was never confirmed.
  const shown = mine.filter((grant) => showRemoved || isLive(grant) || grantView(grant) === 'UNCONFIRMED');
  return (
    <SettingsSection
      title="Secrets on this machine"
      className="machine-section-secrets"
      description="Each copy is removed automatically when its task or session ends."
      action={<Link to="/settings/secrets">Settings → Secrets</Link>}
    >
      <div className="secrets-filters" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className={`secrets-chip${showRemoved ? ' is-on' : ''}`}
          aria-pressed={showRemoved}
          onClick={() => setShowRemoved((on) => !on)}
        >
          Show removed (30 days)
        </button>
      </div>
      <GrantsTable grants={shown} now={Date.now()} revoke={revoke} />
    </SettingsSection>
  );
}
