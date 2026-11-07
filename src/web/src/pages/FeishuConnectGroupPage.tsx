import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  FEISHU_CHAT_DEFAULT_MAX_CONCURRENT,
  FEISHU_CHAT_DEFAULT_SESSIONS_PER_DAY,
  FEISHU_CHAT_MAX_CONCURRENT_LIMIT,
  FEISHU_CHAT_SESSIONS_PER_DAY_LIMIT,
  PermissionMode,
  type FeishuChatConfirm,
  type FeishuChatRoute,
  type FeishuChatRoutes,
} from '@orbit/shared';
import { api } from '../api';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Checkbox';
import { NumberInput } from '../components/ui/NumberInput';
import { Radio, RadioGroup } from '../components/ui/Radio';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import '../components/ui/Card.css';
import { workspacesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** `GET /integrations/feishu/chats`, with the ticket the page was opened with (docs/feishu-bot-design.md §8.1). */
export const feishuChatsQuery = (ticket?: string) =>
  queryOptions({
    queryKey: ['integrations', 'feishu', 'chats', ticket ?? null] as const,
    queryFn: () => api<FeishuChatRoutes>(`/integrations/feishu/chats${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`),
  });

/** Each permission mode, as the composer names it, and what it lets a group's sessions do without asking you. */
export const FEISHU_GROUP_MODES: ReadonlyArray<{ value: PermissionMode; label: string; hint: string }> = [
  { value: PermissionMode.DEFAULT, label: 'Default', hint: 'Agents ask you before editing files or running commands.' },
  { value: PermissionMode.PLAN, label: 'Plan', hint: 'Agents only read and plan; they change nothing.' },
  { value: PermissionMode.ACCEPT_EDITS, label: 'Accept Edits', hint: 'Agents edit files without asking, and ask before running commands.' },
  { value: PermissionMode.AUTO, label: 'Auto', hint: 'Agents decide for themselves what is safe to run.' },
  { value: PermissionMode.DONT_ASK, label: "Don't Ask", hint: 'Anything not already allowed is refused without asking you.' },
  { value: PermissionMode.BYPASS, label: 'Bypass', hint: 'Agents run everything without any check. Only for a workspace with nothing to lose.' },
];

export const modeLabel = (mode: string) => FEISHU_GROUP_MODES.find((m) => m.value === mode)?.label ?? mode;

/** §8.1: what connecting the group lets people do, in the words the design asks for. */
export const groupConsequence = (runner: string, mode: string) =>
  `People in this group can make agents act on ${runner} in ${modeLabel(mode)} mode.`;

interface WorkspaceRow {
  id: string;
  name: string;
  enabled?: boolean;
  deletedAt?: string | null;
  runner?: { name?: string | null; displayName?: string | null } | null;
}
const runnerName = (w: WorkspaceRow | undefined) => w?.runner?.displayName || w?.runner?.name || 'its runner';

/**
 * Orbit's confirm page for connecting a Feishu group (docs/feishu-bot-design.md §8.1, §8.3), opened from the bot's
 * `Connect this group to Orbit` card with its one-time ticket. The owner chooses the workspace the group's sessions open
 * in, the permission mode they run with — and the page says what that means — who in the group may start them, and the
 * two limits. Confirming is an owner-channel action: only a login reaches it.
 */
export function FeishuConnectGroupPage() {
  const [params] = useSearchParams();
  const ticket = params.get('ticket') ?? '';
  const chats = useQuery({ ...feishuChatsQuery(ticket), enabled: ticket !== '' });
  const workspaces = useQuery(workspacesQuery());

  if (!ticket || chats.isError || (chats.isSuccess && !chats.data.pending)) {
    return (
      <div className="feishu-page">
        <h1 className="page-title">Connect a Feishu group</h1>
        <Alert
          type="warning"
          title="This link has expired or was already used"
          description={chats.isError ? chats.error.message : 'Send "@bot connect" in the group again, and open the new card\'s link within 30 minutes.'}
        />
        <p>
          <Link to="/settings/integrations/feishu">Back to Feishu settings</Link>
        </p>
      </div>
    );
  }
  if (chats.isPending || workspaces.isPending) {
    return (
      <div className="feishu-page">
        <Spinner />
      </div>
    );
  }
  const live = ((workspaces.data ?? []) as WorkspaceRow[]).filter((w) => !w.deletedAt && w.enabled !== false);
  return <ConnectForm ticket={ticket} pending={chats.data.pending!} workspaces={live} />;
}

function ConnectForm({
  ticket, pending, workspaces,
}: { ticket: string; pending: NonNullable<FeishuChatRoutes['pending']>; workspaces: WorkspaceRow[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const message = useToast();
  const [workspaceId, setWorkspaceId] = useState<string | null>(workspaces.length === 1 ? workspaces[0].id : null);
  const [mode, setMode] = useState<PermissionMode>(PermissionMode.DEFAULT);
  const [who, setWho] = useState<'everyone' | 'listed'>('everyone');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [maxConcurrent, setMaxConcurrent] = useState<number | null>(FEISHU_CHAT_DEFAULT_MAX_CONCURRENT);
  const [perDay, setPerDay] = useState<number | null>(FEISHU_CHAT_DEFAULT_SESSIONS_PER_DAY);
  const ids = { workspace: useId(), mode: useId(), who: useId(), concurrent: useId(), perDay: useId() };
  const members = pending.members;
  const choose = (openId: string, on: boolean) =>
    setChosen((was) => {
      const next = new Set(was);
      if (on) next.add(openId);
      else next.delete(openId);
      return next;
    });

  const workspace = workspaces.find((w) => w.id === workspaceId);
  // In the group's order, and only people still offered.
  const openIds = (members ?? []).map((m) => m.openId).filter((id) => chosen.has(id));
  const confirm = useMutation({
    mutationFn: (body: FeishuChatConfirm) => api<FeishuChatRoute>('/integrations/feishu/chats/confirm', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations', 'feishu', 'chats'] });
      message.success('Group connected', `${pending.chatName ?? 'The group'} can now start sessions in ${workspace?.name ?? 'the workspace'}.`);
      navigate('/settings/integrations/feishu');
    },
  });
  const ready = workspaceId !== null && maxConcurrent !== null && perDay !== null
    && (who === 'everyone' || openIds.length > 0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || confirm.isPending) return;
    confirm.mutate({
      ticket,
      workspaceId: workspaceId!,
      permissionMode: mode,
      allowedOpenIds: who === 'everyone' ? [] : openIds,
      maxConcurrentSessions: maxConcurrent!,
      sessionsPerDay: perDay!,
    });
  };

  return (
    <div className="feishu-page">
      <h1 className="page-title">Connect a Feishu group</h1>
      <p className="feishu-intro">
        Connect <strong>{pending.chatName ?? 'this group'}</strong> to Orbit, so that people in it can start sessions by
        mentioning the bot. Their messages become instructions to agents on your machine, so choose carefully.
        {pending.connected && ' This group is already connected: confirming replaces its settings.'}
      </p>
      <form className="orbit-card feishu-card" onSubmit={submit} aria-label="Connect this group">
        <div className="orbit-card-body feishu-fields">
          <div className="admin-signin-field">
            <label className="admin-signin-label" id={ids.workspace}>
              Workspace
            </label>
            <Select
              aria-labelledby={ids.workspace}
              value={workspaceId}
              placeholder="Choose a workspace"
              options={workspaces.map((w) => ({ value: w.id, label: `${w.name} · ${runnerName(w)}` }))}
              onValueChange={setWorkspaceId}
            />
            <div className="admin-signin-hint">
              Sessions from this group open here. A workspace of its own, with nothing sensitive in its folder, is safest.
            </div>
          </div>

          <div className="admin-signin-field">
            <div className="admin-signin-label" id={ids.mode}>
              Permission mode
            </div>
            <RadioGroup<PermissionMode> aria-labelledby={ids.mode} className="feishu-modes" value={mode} onValueChange={setMode}>
              {FEISHU_GROUP_MODES.map((m) => (
                <Radio key={m.value} value={m.value}>
                  <span className="admin-signin-choice">{m.label}</span>
                  <span className="admin-signin-hint">{m.hint}</span>
                </Radio>
              ))}
            </RadioGroup>
            <Alert
              type={mode === PermissionMode.BYPASS || mode === PermissionMode.AUTO ? 'warning' : 'info'}
              title={groupConsequence(runnerName(workspace), mode)}
              description="Approvals and agents' questions come to you in Feishu, never to the group. People in the group can't change the mode."
              className="feishu-consequence"
            />
          </div>

          <div className="admin-signin-field">
            <div className="admin-signin-label" id={ids.who}>
              Who can start sessions
            </div>
            <RadioGroup<'everyone' | 'listed'> aria-labelledby={ids.who} value={who} onValueChange={setWho}>
              <Radio value="everyone">
                <span className="admin-signin-choice">Everyone in the group</span>
              </Radio>
              <Radio value="listed" disabled={members === null}>
                <span className="admin-signin-choice">Only these people</span>
              </Radio>
            </RadioGroup>
            {who === 'listed' && members && members.length > 0 && (
              <div className="feishu-members" role="group" aria-label="Allowed senders">
                {members.map((m) => (
                  <Checkbox key={m.openId} checked={chosen.has(m.openId)} onCheckedChange={(on) => choose(m.openId, on)}>
                    {m.name ?? 'A member whose name Feishu did not give'}
                  </Checkbox>
                ))}
              </div>
            )}
            {who === 'listed' && members && members.length === 0 && (
              <div className="admin-signin-hint">Nobody else is in this group yet.</div>
            )}
            {members === null && (
              <div className="admin-signin-warning" role="alert">
                Orbit couldn&apos;t read who is in this group from Feishu, so you can only allow everyone in it for now. Check
                that the app has the im:chat:readonly permission and is still in the group, then open the link again.
              </div>
            )}
            <div className="admin-signin-hint">You can always start sessions yourself.</div>
          </div>

          <div className="feishu-limits">
            <div className="admin-signin-field">
              <label className="admin-signin-label" htmlFor={ids.concurrent}>
                Sessions at the same time
              </label>
              <NumberInput id={ids.concurrent} value={maxConcurrent} min={1} max={FEISHU_CHAT_MAX_CONCURRENT_LIMIT} step={1} precision={0} onValueChange={setMaxConcurrent} />
            </div>
            <div className="admin-signin-field">
              <label className="admin-signin-label" htmlFor={ids.perDay}>
                New sessions per day
              </label>
              <NumberInput id={ids.perDay} value={perDay} min={1} max={FEISHU_CHAT_SESSIONS_PER_DAY_LIMIT} step={1} precision={0} onValueChange={setPerDay} />
            </div>
          </div>

          {confirm.isError && <Alert type="error" title="Couldn't connect the group" description={confirm.error.message} />}
          <div className="feishu-actions">
            <Button onClick={() => navigate('/settings/integrations/feishu')} disabled={confirm.isPending}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={!ready} loading={confirm.isPending}>
              Connect group
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
