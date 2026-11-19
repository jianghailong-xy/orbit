import { useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { SettingsHeader } from '../components/settings';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Checkbox';
import { Dialog } from '../components/ui/Dialog';
import { Input } from '../components/ui/Input';
import { PasswordInput } from '../components/ui/PasswordInput';
import { Spinner } from '../components/ui/Spinner';
import { TableFrame } from '../components/ui/Table';
import {
  END_REASON,
  GRANT_CHIP,
  copies,
  createSavedSecret,
  dayAndTime,
  dayOf,
  deleteSavedSecret,
  deliveryLines,
  exposedName,
  grantView,
  isLive,
  lastUsedWhen,
  machineName,
  replaceSavedSecret,
  revokeGrant,
  savedSecretsQuery,
  secretGrantsQuery,
  shortWhen,
  type SavedSecret,
  type SecretGrant,
} from '../lib/accountSecrets';
import { encodeId } from '../lib/idCodec';
import { useToast } from '../lib/toast';
import './SecretsPage.css';

const ALL = '';

/**
 * Settings → Secrets: every copy of a secret the owner handed to an agent, on which machine and why it is (still)
 * there, and the saved secrets "Use saved" offers. Values are write-only: the page never shows one, and asks for one
 * only in Add and Replace, which the owner types (a value must never pass through an agent).
 */
export function SecretsPage(): JSX.Element {
  const qc = useQueryClient();
  const grantsQ = useQuery(secretGrantsQuery());
  const savedQ = useQuery(savedSecretsQuery());
  const [machine, setMachine] = useState(ALL);
  const [showRemoved, setShowRemoved] = useState(false);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<SavedSecret | null>(null);
  const [deleting, setDeleting] = useState<SavedSecret | null>(null);
  const now = Date.now();

  const grants = grantsQ.data?.grants ?? [];
  const saved = savedQ.data?.secrets ?? [];
  const live = grants.filter(isLive);
  const unconfirmed = grants.filter((grant) => grantView(grant) === 'UNCONFIRMED');
  // A copy whose removal was never confirmed stays in view: it is the one that may still be on a machine.
  const listed = grants.filter((grant) => showRemoved || isLive(grant) || grantView(grant) === 'UNCONFIRMED');
  const machines = [...new Set(listed.map(machineName))];
  const shown = machine === ALL ? listed : listed.filter((grant) => machineName(grant) === machine);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['account-secrets'] });
  const revoke = useEndGrant();

  return (
    <div className="settings-page settings-page--wide secrets-page">
      <SettingsHeader
        title="Secrets"
        description="Keys you gave your agents. Orbit never shows a value again, not even to you. An agent can only get a key when you approve it on its request, and only on the machine that session runs on."
      />

      <section className="secrets-section" aria-label="On machines now">
        <div className="secrets-section-head">
          <h2>On machines now</h2>
          <span className="secrets-count">
            {`${live.length} live`}
            {unconfirmed.length > 0 && ` · ${unconfirmed.length} needs attention`}
          </span>
        </div>
        <p className="secrets-section-note">
          Each copy lives on one machine and is removed automatically when its task or session ends.
        </p>
        {unconfirmed.map((grant) => (
          <div key={grant.id} className="secrets-warning" role="alert">
            ⚠ One copy on <b>{machineName(grant)}</b> could not be confirmed removed: the runner was deleted before it
            checked in. Rotate <b>{grant.label}</b> if that machine is not yours anymore.
          </div>
        ))}
        <div className="secrets-filters">
          <div className="secrets-chips" role="group" aria-label="Machine">
            {[ALL, ...machines].map((name) => (
              <button
                key={name || 'all'}
                type="button"
                className={`secrets-chip${machine === name ? ' is-on' : ''}`}
                aria-pressed={machine === name}
                onClick={() => setMachine(name)}
              >
                {name || 'All machines'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`secrets-chip${showRemoved ? ' is-on' : ''}`}
            aria-pressed={showRemoved}
            onClick={() => setShowRemoved((on) => !on)}
          >
            Show removed (30 days)
          </button>
        </div>
        {grantsQ.isPending ? (
          <div className="following-empty">
            <Spinner />
          </div>
        ) : grantsQ.isError ? (
          <div className="following-empty">
            Couldn’t load the copies: {grantsQ.error.message}{' '}
            <Button size="small" onClick={() => void grantsQ.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <GrantsTable grants={shown} now={now} revoke={revoke} />
        )}
      </section>

      <section className="secrets-section" aria-label="Saved">
        <div className="secrets-section-head">
          <h2>Saved</h2>
          <span className="secrets-count">{saved.length}</span>
          <Button variant="primary" size="small" className="secrets-add" onClick={() => setAdding(true)}>
            Add secret
          </Button>
        </div>
        <p className="secrets-section-note">
          Saved secrets appear under “Use saved” on a request. Using one sends a copy, so deleting a saved secret doesn't
          remove copies already on machines.
        </p>
        {savedQ.isPending ? (
          <div className="following-empty">
            <Spinner />
          </div>
        ) : savedQ.isError ? (
          <div className="following-empty">
            Couldn’t load your saved secrets: {savedQ.error.message}{' '}
            <Button size="small" onClick={() => void savedQ.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <SavedTable saved={saved} grants={grants} now={now} onReplace={setReplacing} onDelete={setDeleting} />
        )}
        <p className="secrets-footnote">
          Replacing a saved secret only affects future uses. Copies already on machines keep the old value until their
          task or session ends, or until you revoke them.
        </p>
      </section>

      {adding && <AddDialog onClose={() => setAdding(false)} onDone={refresh} />}
      {replacing && <ReplaceDialog secret={replacing} onClose={() => setReplacing(null)} onDone={refresh} />}
      {deleting && (
        <DeleteDialog
          secret={deleting}
          grants={live.filter((grant) => grant.savedSecretId === deleting.id)}
          onClose={() => setDeleting(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

function Table({ head, empty, children }: { head: string[]; empty: string | null; children: ReactNode }) {
  return (
    <TableFrame>
      <table className="orbit-table secrets-table">
        <thead>
          <tr>
            {head.map((title, index) => (
              <th key={index} scope="col">
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {empty !== null ? (
            <tr className="orbit-table-empty">
              <td colSpan={head.length}>
                <div>{empty}</div>
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </TableFrame>
  );
}

/** Revoke a live copy, or Cancel one still waiting for delivery: the one way this page and a machine page end a copy. */
export function useEndGrant() {
  const qc = useQueryClient();
  const message = useToast();
  return useMutation({
    mutationFn: (grant: SecretGrant) => revokeGrant(grant.id),
    onSuccess: (_, grant) => {
      void qc.invalidateQueries({ queryKey: ['account-secrets'] });
      message.success(
        grant.state === 'PENDING_DELIVERY' ? 'Delivery cancelled' : 'Copy revoked',
        `“${grant.label}” on ${machineName(grant)}.`,
      );
    },
    onError: (e: Error) => message.error("Couldn't end the copy", e.message),
  });
}

/** The On machines now table, also shown filtered to one runner on its machine page (MachineSecrets.tsx). */
export function GrantsTable({ grants, now, revoke }: {
  grants: SecretGrant[];
  now: number;
  revoke: ReturnType<typeof useEndGrant>;
}) {
  const endingId = revoke.isPending ? revoke.variables?.id : null;
  const onEnd = (grant: SecretGrant) => revoke.mutate(grant);
  return (
    <Table
      head={['Secret', 'Exposed as', 'Machine', 'Used by', 'State', '']}
      empty={grants.length === 0 ? 'No copy of a secret is on a machine.' : null}
    >
      {grants.map((grant) => (
        <GrantRow key={grant.id} grant={grant} now={now} ending={endingId === grant.id} onEnd={() => onEnd(grant)} />
      ))}
    </Table>
  );
}

function GrantRow({ grant, now, ending, onEnd }: { grant: SecretGrant; now: number; ending: boolean; onEnd: () => void }) {
  const view = grantView(grant);
  const chip = GRANT_CHIP[view];
  const kind = grant.taskId ? 'task' : 'session';
  const usedBy = grant.taskId
    ? { to: `/tasks/${encodeId(grant.taskId)}`, title: grant.taskTitle ?? 'Untitled task' }
    : { to: `/sessions/${encodeId(grant.sessionId)}`, title: grant.sessionTitle ?? 'Untitled session' };
  const stateLines: { text: string; tone?: 'warn' | 'bad' }[] =
    view === 'ACTIVE'
      ? [{ text: `expires ${dayAndTime(grant.expiresAt)}` }]
      : view === 'WAITING'
        ? deliveryLines(grant, now).map((text) => ({ text, tone: 'warn' as const }))
        : view === 'REMOVING'
          ? [...(grant.endReason ? [{ text: END_REASON[grant.endReason] }] : []), { text: `Waiting for ${machineName(grant)} to delete it` }]
          : view === 'UNCONFIRMED'
            ? [{ text: `Runner deleted ${shortWhen(grant.removedAt ?? grant.createdAt, now)}`, tone: 'bad' }]
            : [{ text: `${grant.endReason ? END_REASON[grant.endReason] : 'Removed'} · ${shortWhen(grant.removedAt ?? grant.createdAt, now)}` }];
  return (
    <tr className={view === 'REMOVED' ? 'secrets-row-ended' : undefined} data-grant={grant.id}>
      <td>
        <div className="secrets-title">{grant.label}</div>
        <div className="secrets-sub">
          {grant.savedSecretId ? 'from saved' : 'entered on card'} · {shortWhen(grant.createdAt, now)}
        </div>
      </td>
      <td>
        <code className="secrets-exposed">
          {grant.exposure === 'FILE' ? 'file' : 'env'} {exposedName(grant)}
        </code>
      </td>
      <td>
        {machineName(grant)}
        {grant.runner.id === null && <span className="secrets-sub"> (deleted)</span>}
      </td>
      <td>
        <Link to={usedBy.to}>{usedBy.title}</Link>
        <div className="secrets-sub">{isLive(grant) && view !== 'REMOVING' ? `${kind} · ends with ${kind}` : kind}</div>
      </td>
      <td>
        <Badge tone={chip.tone}>{chip.text}</Badge>
        {stateLines.map((line, index) => (
          <div key={index} className={`secrets-sub${line.tone ? ` secrets-${line.tone}` : ''}`}>
            {line.text}
          </div>
        ))}
      </td>
      <td className="secrets-actions">
        {view === 'ACTIVE' && (
          <Button size="small" danger loading={ending} onClick={onEnd}>
            Revoke
          </Button>
        )}
        {view === 'WAITING' && (
          <Button size="small" loading={ending} onClick={onEnd}>
            Cancel
          </Button>
        )}
      </td>
    </tr>
  );
}

function SavedTable({ saved, grants, now, onReplace, onDelete }: {
  saved: SavedSecret[];
  grants: SecretGrant[];
  now: number;
  onReplace: (secret: SavedSecret) => void;
  onDelete: (secret: SavedSecret) => void;
}) {
  return (
    <Table
      head={['Label', 'Saved', 'Last used', 'Live copies', '']}
      empty={saved.length === 0 ? 'No saved secrets. Add one, or save a key from a request.' : null}
    >
      {saved.map((secret) => {
        const mine = grants.filter((grant) => grant.savedSecretId === secret.id && isLive(grant));
        const waiting = mine.length > 0 && mine.every((grant) => grant.state === 'PENDING_DELIVERY');
        const { count, runnerNames } = secret.liveCopies;
        return (
          <tr key={secret.id} data-saved={secret.id}>
            <td className="secrets-title">{secret.label}</td>
            <td>{dayOf(secret.createdAt)}</td>
            <td>{lastUsedWhen(secret.lastUsedAt, now)}</td>
            <td>
              {count === 0 ? (
                <span className="secrets-sub">None</span>
              ) : (
                `${count} · ${runnerNames.join(', ')}${waiting ? ' (waiting)' : ''}`
              )}
            </td>
            <td className="secrets-actions">
              <Button size="small" onClick={() => onReplace(secret)}>
                Replace
              </Button>
              <Button size="small" danger onClick={() => onDelete(secret)}>
                Delete
              </Button>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

function AddDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const message = useToast();
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const add = useMutation({
    mutationFn: () => createSavedSecret(label.trim(), value),
    gcTime: 0,
    onSuccess: () => {
      onDone();
      message.success('Secret saved', `“${label.trim()}” is offered under “Use saved”.`);
      onClose();
    },
    onError: (e: Error) => message.error("Couldn't save the secret", e.message),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add secret"
      description="Agents never see it here: it is offered under “Use saved” when an agent asks for a key, and sent only when you approve."
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} disabled={!label.trim() || !value} onClick={() => add.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="secrets-form">
        <label className="secrets-field">
          <span>Label</span>
          <Input value={label} maxLength={100} placeholder="OpenRouter key" onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="secrets-field">
          <span>Value</span>
          <PasswordInput
            value={value}
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the key"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}

function ReplaceDialog({ secret, onClose, onDone }: { secret: SavedSecret; onClose: () => void; onDone: () => void }) {
  const message = useToast();
  const [value, setValue] = useState('');
  const replace = useMutation({
    mutationFn: () => replaceSavedSecret(secret.id, value),
    gcTime: 0,
    onSuccess: () => {
      onDone();
      message.success('Secret replaced', `Future uses of “${secret.label}” get the new value.`);
      onClose();
    },
    onError: (e: Error) => message.error("Couldn't replace the secret", e.message),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Replace “${secret.label}”`}
      description="Only future uses get the new value. Copies already on machines keep the old one until their task or session ends, or until you revoke them."
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={replace.isPending} disabled={!value} onClick={() => replace.mutate()}>
            Replace
          </Button>
        </>
      }
    >
      <label className="secrets-field">
        <span>New value</span>
        <PasswordInput
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste the new key"
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
    </Dialog>
  );
}

function DeleteDialog({ secret, grants, onClose, onDone }: {
  secret: SavedSecret;
  /** The live copies made from it. */
  grants: SecretGrant[];
  onClose: () => void;
  onDone: () => void;
}) {
  const message = useToast();
  const n = secret.liveCopies.count;
  const [revokeCopies, setRevokeCopies] = useState(n > 0);
  const remove = useMutation({
    mutationFn: () => deleteSavedSecret(secret.id, n > 0 && revokeCopies),
    onSuccess: () => {
      onDone();
      message.success('Secret deleted', n > 0 && revokeCopies ? `Its ${copies(n)} ${n === 1 ? 'is' : 'are'} being revoked.` : undefined);
      onClose();
    },
    onError: (e: Error) => message.error("Couldn't delete the secret", e.message),
  });
  const where = secret.liveCopies.runnerNames.join(', ');
  const one = grants.length === 1 ? grants[0] : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete “${secret.label}”?`}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" danger loading={remove.isPending} onClick={() => remove.mutate()}>
            Delete
          </Button>
        </>
      }
    >
      <p className="secrets-dialog-text">
        Agents will no longer be offered it under “Use saved”.
        {n > 0 && ` ${n === 1 ? '1 copy' : `${n} copies`} made from it ${n === 1 ? 'is' : 'are'} still on ${where}.`}
      </p>
      {n > 0 && (
        <label className="secrets-revoke-choice">
          <Checkbox checked={revokeCopies} onCheckedChange={setRevokeCopies} aria-label={`Also revoke the ${copies(n)}`} />
          <span>
            <span>{`Also revoke the ${copies(n)}`}</span>
            <span className="secrets-sub">
              {one
                ? `The ${one.taskId ? 'task' : 'session'} “${one.taskTitle ?? one.sessionTitle ?? 'Untitled'}” will lose ${exposedName(one)} within about 30 s.`
                : 'Each task or session using one loses it within about 30 s.'}
            </span>
          </span>
        </label>
      )}
    </Dialog>
  );
}
