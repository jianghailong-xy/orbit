import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Dropdown, Input, Modal, Switch, type MenuProps } from 'antd';
import {
  CheckCircleFilled,
  EllipsisOutlined,
  ExclamationCircleFilled,
  UserAddOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { api, ApiError } from '../api';
import { encodeId } from '../lib/idCodec';
import {
  maskTyped,
  personColor,
  personShare,
  SHARED_POOLS_BASE,
  type SharedPool,
  type SharedPoolKey,
  type SharedPoolPerson,
} from '../lib/sharedPools';
import { useToast } from '../lib/toast';

/**
 * What a shared pool (organization/project OpenAI API keys several people run Codex on) adds to the
 * pool page and the Providers page: its people, its two rules, and the ways a key goes in — "Add a
 * key", and "Replace key" for one OpenAI refused. The key a person pastes goes to the server once and
 * is never shown again: from then on it is `sk-…` and its last four characters.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const poolPath = (pool: SharedPool) => `${SHARED_POOLS_BASE}/${encodeId(pool.id)}`;

/** A person: a circle with their initial, in their colour in this pool. */
export function PersonMark({
  pool,
  userId,
  name,
  size = 28,
}: {
  pool: SharedPool;
  userId: string;
  name: string;
  size?: number;
}) {
  return (
    <span
      className="pool-av"
      style={{ background: personColor(pool, userId), width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** Who shares the pool, overlapping, for a card's head. */
export function PeopleStack({ pool }: { pool: SharedPool }) {
  const shown = pool.people.slice(0, 5);
  const more = pool.people.length - shown.length;
  return (
    <span className="pool-people pool-wide" title={pool.people.map((person) => person.name).join(', ')}>
      {shown.map((person) => (
        <PersonMark key={person.userId} pool={pool} userId={person.userId} name={person.name} size={20} />
      ))}
      {more > 0 && <span className="pool-people-more">+{more}</span>}
    </span>
  );
}

/** A write to a shared pool, after which every provider read — the pool's page, its card, the
 *  pickers — reads again. */
function usePoolWrite<T>(write: (input: T) => Promise<unknown>, onDone?: () => void) {
  const qc = useQueryClient();
  const message = useToast();
  return useMutation({
    mutationFn: write,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      onDone?.();
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });
}

/** Who is in the pool: what each put in, how many sessions each ran on it, and their share of this
 *  month's use — everyone's is shown to everyone, and a person with no key of their own is in it too. */
export function PoolPeopleCard({ pool }: { pool: SharedPool }) {
  const admin = pool.viewerRole === 'ADMIN';
  const [adding, setAdding] = useState(false);
  return (
    <div className="re-card pool-card pool-sub-sec pool-people-card">
      <div className="re-head">
        <span className="re-runner">
          Members<span className="pool-head-count">{pool.people.length}</span>
        </span>
        <span className="re-head-sp" />
        <span className="pool-head-note">Share of this month’s use</span>
        {admin && (
          <Button size="small" icon={<UserAddOutlined />} onClick={() => setAdding(true)}>
            Add members
          </Button>
        )}
      </div>
      {pool.people.map((person) => (
        <PersonRow key={person.userId} pool={pool} person={person} />
      ))}
      {adding && <AddPeopleModal pool={pool} onClose={() => setAdding(false)} />}
    </div>
  );
}

function PersonRow({ pool, person }: { pool: SharedPool; person: SharedPoolPerson }) {
  const share = personShare(pool, person);
  // Nobody manages themselves from here, and the pool's creator stays one of its admins.
  const manage = pool.viewerRole === 'ADMIN' && !person.you && !person.creator;
  return (
    <div className="pool-person" data-person={person.userId}>
      <div className="pool-person-id">
        <PersonMark pool={pool} userId={person.userId} name={person.name} />
        <div style={{ minWidth: 0 }}>
          <div className="pool-person-name">
            <span>{person.name}</span>
            {person.you && <span className="pool-you">you</span>}
            {person.role === 'ADMIN' && <span className="re-chip">ADMIN</span>}
          </div>
          <div className="pool-person-meta">
            {person.keys ? plural(person.keys, 'key') : 'No key'} · {plural(person.sessions, 'session')}
          </div>
        </div>
      </div>
      <div className="pool-share">
        <span className="runner-util">
          <span className="runner-util-fill" style={{ width: `${share}%` }} />
        </span>
        <span className="pool-share-pct">{share}%</span>
      </div>
      <div className="pool-person-more">{manage && <PersonMenu pool={pool} person={person} />}</div>
    </div>
  );
}

/** An admin's say over another person: their role, and whether they stay. */
function PersonMenu({ pool, person }: { pool: SharedPool; person: SharedPoolPerson }) {
  const { modal } = App.useApp();
  const at = `${poolPath(pool)}/people/${encodeId(person.userId)}`;
  const setRole = usePoolWrite((role: 'ADMIN' | 'MEMBER') => api(at, { method: 'PATCH', body: { role } }));
  const remove = usePoolWrite(() => api(at, { method: 'DELETE' }));
  const items: MenuProps['items'] = [
    { key: 'role', label: person.role === 'ADMIN' ? 'Make member' : 'Make admin' },
    { key: 'remove', label: 'Remove from pool', danger: true },
  ];
  const onClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'role') {
      setRole.mutate(person.role === 'ADMIN' ? 'MEMBER' : 'ADMIN');
      return;
    }
    modal.confirm({
      title: `Remove ${person.name} from ${pool.label}?`,
      content: 'Their keys leave with them.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: () => remove.mutateAsync(undefined),
    });
  };
  return (
    <Dropdown trigger={['click']} menu={{ items, onClick }}>
      <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label={`Manage ${person.name}`} />
    </Dropdown>
  );
}

/** An admin adds a person by the email of their Orbit account. */
function AddPeopleModal({ pool, onClose }: { pool: SharedPool; onClose: () => void }) {
  const message = useToast();
  const [email, setEmail] = useState('');
  const add = usePoolWrite(
    () => api(`${poolPath(pool)}/people`, { method: 'POST', body: { email: email.trim() } }),
    () => {
      message.success(`Added to ${pool.label}`);
      onClose();
    },
  );
  return (
    <Modal
      open
      width={460}
      title={`Add members to ${pool.label}`}
      okText="Add"
      okButtonProps={{ disabled: !email.includes('@'), loading: add.isPending }}
      onOk={() => add.mutate(undefined)}
      onCancel={onClose}
    >
      <label className="np-field">
        <span className="np-field-l">Email of their Orbit account</span>
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoFocus />
      </label>
      <div className="np-field-h">
        They see it on their Providers page and in the session picker, and can start sessions on it.
      </div>
    </Modal>
  );
}

/** The two rules an admin sets. Everyone else reads them. */
export function PoolRulesCard({ pool }: { pool: SharedPool }) {
  const admin = pool.viewerRole === 'ADMIN';
  const save = usePoolWrite((rules: { membersCanAdd?: boolean; ownKeyFirst?: boolean }) =>
    api(poolPath(pool), { method: 'PATCH', body: rules }),
  );
  return (
    <div className="re-card pool-card pool-sub-sec pool-rules-card">
      <div className="re-head">
        <span className="re-runner">Rules</span>
        <span className="re-head-sp" />
        {!admin && <span className="pool-head-note">Set by the pool’s admins</span>}
      </div>
      <div className="pool-rule">
        <div>
          <div className="pool-rule-t">Members can add keys</div>
          <div className="pool-rule-h">
            Anyone in {pool.label} can put an OpenAI API key in. Off: only admins can.
          </div>
        </div>
        <Switch
          checked={pool.membersCanAdd}
          disabled={!admin}
          loading={save.isPending && save.variables?.membersCanAdd !== undefined}
          onChange={(on) => save.mutate({ membersCanAdd: on })}
          aria-label="Members can add keys"
        />
      </div>
      <div className="pool-rule">
        <div>
          <div className="pool-rule-t">Own key first</div>
          <div className="pool-rule-h">
            A member’s sessions start on a key they added while it has room, then move on to the
            others’.
          </div>
        </div>
        <Switch
          checked={pool.ownKeyFirst}
          disabled={!admin}
          loading={save.isPending && save.variables?.ownKeyFirst !== undefined}
          onChange={(on) => save.mutate({ ownKeyFirst: on })}
          aria-label="Own key first"
        />
      </div>
    </div>
  );
}

/** Who put in the key a second add was refused over, as the refusal names them. */
type AddedBy = { name: string; you: boolean };

const duplicateOf = (e: unknown): AddedBy | null => {
  if (!(e instanceof ApiError) || e.code !== 'POOL_KEY_DUPLICATE') return null;
  const by = e.body?.addedBy as Partial<AddedBy> | undefined;
  return { name: typeof by?.name === 'string' ? by.name : 'Someone', you: by?.you === true };
};

/** The Key field of "Add a key" and "Replace key": what was typed is sent once, and all that is said of
 *  it here and ever after is its fingerprint. */
function KeyField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}) {
  return (
    <div className="np-field">
      <span className="np-field-l">Key</span>
      <Input.Password
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="sk-…"
        autoComplete="off"
        aria-label="Key"
        status={error ? 'error' : undefined}
      />
      {error ? (
        <div className="np-field-h np-field-err">{error}</div>
      ) : (
        <div className="np-field-h">
          Checked once, then only its fingerprint (<b>{maskTyped(value)}</b>) is shown — the key itself
          stays on the Orbit server.
        </div>
      )}
    </div>
  );
}

type AddStep = 'consent' | 'form' | 'done' | 'dup';

/**
 * "Add a key": what putting one's key in means (and the notice that it is not to be resold), then its
 * name, the key and what the others may spend on it, then how it went — in, shown as its fingerprint,
 * or refused because the same key is in the pool already.
 */
export function AddKeyModal({ pool, onClose }: { pool: SharedPool; onClose: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<AddStep>('consent');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [cap, setCap] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ label: string; fingerprint: string } | null>(null);
  const [addedBy, setAddedBy] = useState<AddedBy | null>(null);
  const me = pool.people.find((person) => person.you);

  const add = useMutation({
    mutationFn: async () => {
      // Which keys were there before, read now: the pool on screen may already have been re-read
      // with the new key in it by the time the answer arrives.
      const before = new Set(pool.keys.map((key) => key.id));
      const typed = { label: label.trim(), fingerprint: maskTyped(apiKey) };
      const next = await api<SharedPool>(`${poolPath(pool)}/keys`, {
        method: 'POST',
        body: { label: typed.label, apiKey: apiKey.trim(), shareCap: cap === '' ? null : Number(cap) },
      });
      const key: SharedPoolKey | undefined = next.keys.find((row) => !before.has(row.id));
      return key ?? typed;
    },
    onSuccess: (key) => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      setAdded({ label: key.label, fingerprint: key.fingerprint });
      setApiKey('');
      setStep('done');
    },
    onError: (e: Error) => {
      const by = duplicateOf(e);
      if (by) {
        setAddedBy(by);
        setStep('dup');
        return;
      }
      setError(e.message || 'Failed');
    },
  });

  const footer =
    step === 'consent' ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="primary" onClick={() => setStep('form')}>
          Continue
        </Button>
      </>
    ) : step === 'form' ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          type="primary"
          disabled={!label.trim() || !apiKey.trim()}
          loading={add.isPending}
          onClick={() => {
            setError(null);
            add.mutate();
          }}
        >
          Add key
        </Button>
      </>
    ) : step === 'dup' ? (
      <>
        <Button onClick={onClose}>Close</Button>
        <Button
          type="primary"
          onClick={() => {
            setApiKey('');
            setStep('form');
          }}
        >
          Add another key
        </Button>
      </>
    ) : (
      <Button type="primary" onClick={onClose}>
        Done
      </Button>
    );

  return (
    <Modal open width={500} title={`Add a key to ${pool.label}`} footer={footer} onCancel={onClose}>
      {step === 'consent' && (
        <div className="pa-consent">
          <div className="pa-lead">Paste an OpenAI API key to put in this pool.</div>
          <ul className="pa-facts">
            <li>
              <b>Everyone in {pool.label} can run sessions on it</b> —{' '}
              {plural(pool.people.length, 'person', 'people')}. Their sessions spend this key’s budget.
            </li>
            <li>
              <b>The key stays on the Orbit server.</b> It never goes to a runner — runners get a
              session token, not the key — and nobody in the pool sees it or its full value.
            </li>
            <li>
              <b>Take it out, or replace it, any time.</b> Its usage shows on this page for everyone
              in the pool.
            </li>
          </ul>
          <div className="pa-risk">
            <WarningFilled />
            <span>
              <b>Keys can’t be resold.</b> Everything run with this key is billed to its account, and
              the person who adds it is responsible for it.
            </span>
          </div>
        </div>
      )}
      {step === 'form' && (
        <div className="pa-form">
          <div className="pa-lead">Name it, paste it, and set what the others may spend on it.</div>
          <label className="np-field">
            <span className="np-field-l">Name</span>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} autoFocus />
          </label>
          <KeyField
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              setError(null);
            }}
            error={error}
          />
          <div className="np-field">
            <span className="np-field-l">Limit</span>
            <Input
              prefix="$"
              suffix="a month"
              value={cap}
              inputMode="numeric"
              placeholder="No limit"
              aria-label="Limit"
              onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))}
            />
            <div className="np-field-h">
              Others in {pool.label} can spend up to this on the key each month. Your own sessions
              aren’t limited by it.
            </div>
          </div>
        </div>
      )}
      {step === 'done' && added && (
        <div className="pa-added">
          <div className="pa-done">
            <CheckCircleFilled />
            <div>
              <div className="pa-done-t">
                {added.label} is in {pool.label}
              </div>
              <div className="pa-done-s">
                <b>{added.fingerprint}</b> · ready for the next session. Only you and the pool’s admins
                can replace it.
              </div>
            </div>
          </div>
          {me && (
            <div className="pa-acct">
              <PersonMark pool={pool} userId={me.userId} name={me.name} />
              <div>
                <div className="pa-acct-t">{added.label}</div>
                <div className="pa-acct-s">
                  {me.name} · {added.fingerprint} · only its fingerprint is ever shown
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {step === 'dup' && (
        <div className="pa-done pa-dup">
          <ExclamationCircleFilled />
          <div>
            <div className="pa-done-t">This key is already in {pool.label}</div>
            <div className="pa-done-s">
              {addedBy?.you ? 'You' : (addedBy?.name ?? 'Someone')} added it. The same key twice doesn’t add
              budget — add a different one.
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** "Replace key": a working key pasted over one OpenAI refused, by its contributor or an admin. It keeps
 *  its name, its contributor and its cap. */
export function ReplaceKeyModal({
  pool,
  poolKey,
  onClose,
}: {
  pool: SharedPool;
  poolKey: SharedPoolKey;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const message = useToast();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const replace = useMutation({
    mutationFn: () =>
      api(`${poolPath(pool)}/keys/${encodeId(poolKey.id)}/secret`, {
        method: 'PUT',
        body: { apiKey: apiKey.trim() },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      message.success(`${poolKey.label} is back in ${pool.label}`);
      onClose();
    },
    onError: (e: Error) => {
      const by = duplicateOf(e);
      setError(
        by
          ? `This key is already in ${pool.label} — ${by.you ? 'you' : by.name} added it.`
          : e.message || 'Failed',
      );
    },
  });
  return (
    <Modal
      open
      width={500}
      title={`Replace ${poolKey.label}`}
      okText="Replace key"
      okButtonProps={{ disabled: !apiKey.trim(), loading: replace.isPending }}
      onOk={() => {
        setError(null);
        replace.mutate();
      }}
      onCancel={onClose}
    >
      <div className="pa-lead">
        OpenAI rejected {poolKey.fingerprint}. Paste a working key to put {poolKey.label} back in the pool.
      </div>
      <KeyField
        value={apiKey}
        onChange={(value) => {
          setApiKey(value);
          setError(null);
        }}
        error={error}
      />
    </Modal>
  );
}
