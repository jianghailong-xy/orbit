import { Fragment, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Checkbox, Dropdown, Input, Modal, Segmented, Select, Switch, type MenuProps } from 'antd';
import {
  CheckCircleFilled,
  EllipsisOutlined,
  ExclamationCircleFilled,
  LockOutlined,
  UserAddOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { api, ApiError } from '../api';
import { encodeId } from '../lib/idCodec';
import {
  hasPeople,
  maskTyped,
  ownsPool,
  personColor,
  personShare,
  poolOwner,
  SHARED_POOLS_BASE,
  type SharedPool,
  type SharedPoolKey,
  type SharedPoolPerson,
} from '../lib/sharedPools';
import { useToast } from '../lib/toast';

/**
 * What a Codex pool's people and its API keys (organization/project OpenAI API keys several people run
 * Codex on) add to the pool page and the Providers page: who can use it and how it is shared, and the
 * ways a key goes in — "Add a key", and "Replace key" for one OpenAI refused. The key a person pastes goes
 * to the server once and is never shown again: from then on it is `sk-…` and its last four characters.
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

/** `a`, `a and b`, `a, b and c`: names in a sentence. */
const listOf = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * "Who can use it" (docs/mocks/account-pool-access/02): its owner keeps the pool to themselves (Just me)
 * or adds people by the email of their Orbit account (Me and people I add). Who can use a pool is its
 * people and nothing else, so the switch adds people — through Share — or, after asking, takes every one
 * of them out. Each person's row says what their sessions run on, how many keys they put in, how many
 * sessions they started this month and their share of this month's API key use, which everyone in the
 * pool sees. The people the owner added read all of it and change none of it. While a pool shared with
 * people has no API key, its owner is told at the foot of the card that none of them can start a session
 * on it yet (02, the boundary state), and offered Add an API key.
 *
 * `accounts` is how many ChatGPT accounts of the owner's the pool holds — null for a pool made on the
 * shared pools page, which never holds one — and `onAddKey` opens Add a key.
 */
export function WhoCanUseItCard({
  pool,
  accounts,
  onAddKey,
}: {
  pool: SharedPool;
  accounts: number | null;
  onAddKey: () => void;
}) {
  const { modal } = App.useApp();
  const mine = ownsPool(pool);
  const people = hasPeople(pool);
  // Everybody in it but its owner: the people they added.
  const added = pool.people.filter((person) => !person.creator);
  const [sharing, setSharing] = useState(false);
  const save = usePoolWrite((rules: { membersCanAdd: boolean }) =>
    api(poolPath(pool), { method: 'PATCH', body: rules }),
  );
  // Back to Just me: everybody but its owner out, and their keys and session tokens with them.
  const keepToSelf = usePoolWrite(async () => {
    for (const person of pool.people) {
      if (!person.creator) await api(`${poolPath(pool)}/people/${encodeId(person.userId)}`, { method: 'DELETE' });
    }
  });
  const justMine = () =>
    modal.confirm({
      title: `Make ${pool.label} just yours?`,
      content: <JustMineCost pool={pool} accounts={accounts} />,
      okText: 'Make it just mine',
      okButtonProps: { danger: true },
      onOk: () => keepToSelf.mutateAsync(undefined),
    });
  return (
    <div className="re-card pool-card pool-sub-sec who-card">
      <div className="re-head">
        <span className="re-runner">
          Who can use it{people && <span className="pool-head-count">{pool.people.length}</span>}
        </span>
        <span className="re-head-sp" />
        {people && (
          <span className="pool-head-note">
            {mine
              ? 'Share of this month’s API key use'
              : `Set by ${poolOwner(pool)?.name} · share of this month’s API key use`}
          </span>
        )}
        {mine && people && (
          <Button size="small" icon={<UserAddOutlined />} onClick={() => setSharing(true)}>
            Add people
          </Button>
        )}
      </div>
      {mine && (
        <div className="who-mode">
          {/* What it says is the pool's people: a press opens what changes them, and the pool's next
              read moves it. */}
          <Segmented
            value={people ? 'people' : 'me'}
            options={[
              { value: 'me', label: 'Just me' },
              { value: 'people', label: 'Me and people I add' },
            ]}
            onChange={(value) => (value === 'people' ? setSharing(true) : justMine())}
          />
          <span className="who-mode-h">
            {people
              ? `They see ${pool.label} on their Providers page and in the session picker.`
              : 'Nobody else in Orbit sees this pool or its accounts.'}
          </span>
        </div>
      )}
      {people && pool.people.map((person) => <PersonRow key={person.userId} pool={pool} person={person} accounts={accounts} />)}
      {mine && people && (
        <div className="pool-rule">
          <div>
            <div className="pool-rule-t">They can add their own API keys</div>
            <div className="pool-rule-h">
              Off: only you put keys in. A key they add runs everyone’s sessions here, theirs first.
            </div>
          </div>
          <Switch
            checked={pool.membersCanAdd}
            loading={save.isPending}
            onChange={(on) => save.mutate({ membersCanAdd: on })}
            aria-label="They can add their own API keys"
          />
        </div>
      )}
      {mine && people && accounts !== null && (
        <div className="who-foot">
          <LockOutlined />
          <span>
            <b>Your ChatGPT accounts only ever run your own sessions.</b> OpenAI’s terms don’t allow a ChatGPT
            account to be shared, so nobody you add can run on one — or see which accounts they are.
          </span>
        </div>
      )}
      {mine && people && pool.keys.length === 0 && (
        <div className="who-warn">
          <WarningFilled />
          <span>
            <b>{listOf(added.map((person) => person.name))} can’t start a session here yet.</b> {pool.label} has no
            API key{accounts !== null ? ', and your ChatGPT accounts only run your own sessions' : ''}.
          </span>
          <Button size="small" type="primary" onClick={onAddKey}>
            Add an API key
          </Button>
        </div>
      )}
      {sharing && (
        <SharePoolModal pool={pool} accounts={accounts} onAddKey={onAddKey} onClose={() => setSharing(false)} />
      )}
    </div>
  );
}

/** One person: what their sessions run on — said to the owner, as the rule it is — the keys they put in,
 *  the sessions they started this month, and their share of this month's API key use. */
function PersonRow({
  pool,
  person,
  accounts,
}: {
  pool: SharedPool;
  person: SharedPoolPerson;
  accounts: number | null;
}) {
  const mine = ownsPool(pool);
  // Nothing has run on the pool's keys this month: there is no share to draw yet.
  const ran = pool.people.some((row) => row.usage.costUsd > 0);
  const share = personShare(pool, person);
  const sessions = plural(person.sessions, 'session');
  // The owner's own sessions run on its ChatGPT accounts first; everybody else's — and everybody's in a
  // pool of keys alone — on its API keys.
  const everything = person.creator && accounts !== null;
  return (
    <div className="pool-person" data-person={person.userId}>
      <div className="pool-person-id">
        <PersonMark pool={pool} userId={person.userId} name={person.name} />
        <div style={{ minWidth: 0 }}>
          <div className="pool-person-name">
            <span>{person.name}</span>
            {person.you && <span className="pool-you">you</span>}
            {person.creator ? (
              <span className="re-chip">OWNER</span>
            ) : (
              person.role === 'ADMIN' && <span className="re-chip">ADMIN</span>
            )}
          </div>
          <div className="pool-person-meta">
            {!mine ? (
              `${person.keys ? plural(person.keys, 'key') : 'No key'} · ${sessions}`
            ) : everything ? (
              <>
                <span className="pool-runs all">Runs on everything — your ChatGPT accounts first</span> · {sessions}
              </>
            ) : (
              <>
                <span className="pool-runs">Runs on the API keys</span> ·{' '}
                {person.keys ? plural(person.keys, 'key') : 'no key'} · {sessions}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="pool-share">
        {ran && (
          <>
            <span className="runner-util">
              <span className="runner-util-fill" style={{ width: `${share}%` }} />
            </span>
            <span className="pool-share-pct">{share}%</span>
          </>
        )}
      </div>
      <div className="pool-person-more">{mine && !person.creator && <PersonMenu pool={pool} person={person} />}</div>
    </div>
  );
}

/** The owner's say over somebody they added: whether they stay — and, in a pool made on the shared pools
 *  page, which may have more admins than its maker, whether they are one. */
function PersonMenu({ pool, person }: { pool: SharedPool; person: SharedPoolPerson }) {
  const { modal } = App.useApp();
  const at = `${poolPath(pool)}/people/${encodeId(person.userId)}`;
  const setRole = usePoolWrite((role: 'ADMIN' | 'MEMBER') => api(at, { method: 'PATCH', body: { role } }));
  const remove = usePoolWrite(() => api(at, { method: 'DELETE' }));
  const items: MenuProps['items'] = [
    ...(pool.shared ? [{ key: 'role', label: person.role === 'ADMIN' ? 'Make member' : 'Make admin' }] : []),
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

/** What going back to Just me costs (03-5): who loses the pool, which keys go with them — a key goes with
 *  whoever added it — and what stays. */
function JustMineCost({ pool, accounts }: { pool: SharedPool; accounts: number | null }) {
  const others = pool.people.filter((person) => !person.creator);
  const owner = poolOwner(pool);
  const keysOf = (userId: string) =>
    pool.keys.filter((key) => key.contributor.userId === userId).map((key) => key.label);
  const leaving = others.flatMap((person) => {
    const keys = keysOf(person.userId);
    return keys.length > 0 ? [{ person, keys }] : [];
  });
  const staying = [
    ...(accounts ? [accounts === 1 ? 'Your ChatGPT account' : 'Your ChatGPT accounts'] : []),
    ...(owner ? keysOf(owner.userId) : []),
  ];
  return (
    <>
      {listOf(others.map((person) => person.name))} {others.length === 1 ? 'loses' : 'lose'} it at once, and
      their sessions on it stop.
      {leaving.length > 0 && (
        <>
          {' '}
          {leaving.map(({ person, keys }, at) => (
            <Fragment key={person.userId}>
              {at > 0 && (at === leaving.length - 1 ? ' and ' : ', ')}
              <b>
                {listOf(keys)} {keys.length === 1 ? 'leaves' : 'leave'} with {person.name}
              </b>
            </Fragment>
          ))}
          , because a key goes with whoever added it.
        </>
      )}
      {staying.length > 0 &&
        ` ${listOf(staying)} ${staying.length > 1 || (accounts ?? 0) > 1 ? 'stay' : 'stays'}.`}
    </>
  );
}

/**
 * "Share <pool>" (03-4): who to add, by the email of their Orbit account, and — before they are in — what
 * that means: the pool on their pages, its API keys to run on and never the owner's ChatGPT accounts, and
 * everybody's share of the keys' use shown to everybody. A pool with no key yet says first that they could
 * not start a session on it, and offers to add one first.
 */
function SharePoolModal({
  pool,
  accounts,
  onAddKey,
  onClose,
}: {
  pool: SharedPool;
  accounts: number | null;
  onAddKey: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const message = useToast();
  const [emails, setEmails] = useState<string[]>([]);
  // An address typed but not yet turned into a tag still counts.
  const [typing, setTyping] = useState('');
  const [canAdd, setCanAdd] = useState(pool.membersCanAdd);
  const typed = [...new Set([...emails, typing].map((email) => email.trim()).filter(Boolean))];
  const noKey = pool.keys.length === 0;
  const share = useMutation({
    mutationFn: async () => {
      const missed: string[] = [];
      for (const email of typed) {
        // One unknown address doesn't stop the rest: it is named once they are in.
        await api(`${poolPath(pool)}/people`, { method: 'POST', body: { email } }).catch((e: Error) =>
          missed.push(`${email} (${e.message})`),
        );
      }
      if (!noKey && canAdd !== pool.membersCanAdd) {
        await api(poolPath(pool), { method: 'PATCH', body: { membersCanAdd: canAdd } });
      }
      return missed;
    },
    onSuccess: (missed) => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      if (missed.length) message.warning(`Not added: ${missed.join(', ')}`);
      else message.success(`Added to ${pool.label}`);
      onClose();
    },
    onError: (e: Error) => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      message.error(e.message || 'Failed');
    },
  });
  const footer = noKey ? (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button disabled={typed.length === 0} loading={share.isPending} onClick={() => share.mutate()}>
        Share anyway
      </Button>
      <Button
        type="primary"
        onClick={() => {
          onClose();
          onAddKey();
        }}
      >
        Add an API key first
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button type="primary" disabled={typed.length === 0} loading={share.isPending} onClick={() => share.mutate()}>
        Share
      </Button>
    </>
  );
  return (
    <Modal open width={500} title={`Share ${pool.label}`} footer={footer} onCancel={onClose}>
      <div className="np-field">
        <span className="np-field-l">Emails of their Orbit accounts</span>
        <Select
          mode="tags"
          className="pool-share-emails"
          value={emails}
          onChange={(next: string[]) => {
            setEmails(next);
            setTyping('');
          }}
          onSearch={setTyping}
          searchValue={typing}
          tokenSeparators={[',', ' ']}
          open={false}
          aria-label="People to add"
        />
      </div>
      {noKey ? (
        <div className="pa-risk">
          <WarningFilled />
          <span>
            <b>{pool.label} has no API key yet.</b> They’ll see it but can’t start a session until it has one
            {accounts !== null ? ', because your ChatGPT accounts only run your own sessions' : ''}.
          </span>
        </div>
      ) : (
        <>
          <ul className="pa-facts">
            <li>
              <b>They see {pool.label}</b> on their Providers page and in the session picker, and can start
              sessions on it.
            </li>
            <li>
              <b>Their sessions run on the pool’s API keys</b>, which {pool.keys.length === 1 ? 'is' : 'are'}{' '}
              {listOf(pool.keys.map((key) => key.label))} now.
              {accounts === 1 &&
                ' Your ChatGPT account stays yours alone: they can’t run on it or see which account it is.'}
              {(accounts ?? 0) > 1 &&
                ` Your ${accounts} ChatGPT accounts stay yours alone: they can’t run on them or see which accounts they are.`}
            </li>
            <li>
              <b>Everyone sees each person’s share</b> of this month’s API key use.
            </li>
          </ul>
          <Checkbox checked={canAdd} onChange={(e) => setCanAdd(e.target.checked)}>
            They can add their own API keys
          </Checkbox>
        </>
      )}
    </Modal>
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
