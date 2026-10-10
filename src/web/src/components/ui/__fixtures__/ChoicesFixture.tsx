import { useRef, useState, type ReactNode } from 'react';
import { App as AntApp, Button as AntButton, ConfigProvider, Drawer as AntDrawer, Dropdown, Modal, Popconfirm as AntPopconfirm, Popover as AntPopover, Select as AntSelect, Tooltip as AntTooltip } from 'antd';
import { CodeOutlined, GlobalOutlined, LockOutlined, PaperClipOutlined, PictureOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useThemeMode } from '../../../lib/theme';
import { darkTheme, lightTheme } from '../../../theme';
import { Button } from '../Button';
import { Input } from '../Input';
import { Dialog } from '../Dialog';
import { Drawer } from '../Drawer';
import { OverlayScope } from '../Overlay';
import { Menu, type MenuItem } from '../Menu';
import { Popconfirm } from '../Popconfirm';
import { Popover } from '../Popover';
import { Tooltip } from '../Tooltip';
import { Select, type SelectOption, type SelectOptions } from '../Select';
import { Combobox } from '../Combobox';
import { MultiSelect } from '../MultiSelect';
import './ChoicesFixture.css';

const expiry = [{ value: 'never', label: 'Never' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days', disabled: true }];
const expiryFirstDisabled = expiry.map((option, index) => index === 0 ? { ...option, disabled: true } : option);
const workspaces: SelectOptions = [{ label: 'Local', options: [{ value: 'orbit', label: 'Orbit workspace' }, { value: 'docs', label: '文档 Docs' }, { value: 'off', label: 'Offline workspace', disabled: true }] },
  { label: 'Remote', options: [{ value: 'runner', label: 'Runner workspace' }] }];
const accounts = [{ value: '', label: 'Automatic' }, { value: 'default', label: 'Default' }, { value: 'work', label: 'Work account', disabled: true }];
const labels = [{ value: 'bug', label: 'Bug' }, { value: 'docs', label: 'Docs' }, { value: 'ops', label: 'Ops' }, { value: 'off', label: 'Archived', disabled: true }];
const accountDetail = (option: SelectOption) => <div><div>{option.label}</div><div className="rd-codex-account-status">{option.value === '' ? 'each new session starts on the account whose quota resets soonest' : option.value === 'default' ? '5-hour 12% · signed in' : 'signed out'}</div></div>;
const attachmentItems: MenuItem[] = [
  { key: 'file', label: 'File', icon: <PaperClipOutlined /> },
  { key: 'image', label: 'Image', icon: <PictureOutlined /> },
  { key: 'separator', type: 'separator' },
  { key: 'shell', label: 'Shell', icon: <CodeOutlined /> },
  { key: 'skill', label: 'Skill', icon: <ThunderboltOutlined />, disabled: true },
  { key: 'command', label: 'Command', icon: <span className="fixture-command-icon">/</span> },
];

function Samples() {
  const params = new URLSearchParams(location.search);
  const legacy = params.get('system') === 'antd';
  const kind = params.get('sample') ?? 'attachment';
  const state = params.get('state') ?? 'default';
  const side = params.get('side') === 'top' ? 'top' : 'bottom';
  const align = params.get('align') === 'end' ? 'end' : params.get('align') === 'center' ? 'center' : 'start';
  const placement = side === 'top' ? 'topLeft' : 'bottomLeft';
  const calloutPlacement = side === 'top' ? align === 'center' ? 'top' : align === 'end' ? 'topRight' : 'topLeft'
    : align === 'center' ? 'bottom' : align === 'end' ? 'bottomRight' : 'bottomLeft';
  const anchor = params.get('anchor');
  // A select sample's starting value (value=none: none, as the replaced dialogs started on undefined), shown in
  // an output; options=first-disabled disables its first option.
  const start = params.get('value');
  const [value, setValue] = useState<string | null>(start === 'none' ? null : start ?? (kind === 'account' ? '' : 'never'));
  const choiceOptions = state === 'empty' ? [] : kind === 'account' ? accounts : params.get('options') === 'first-disabled' ? expiryFirstDisabled : expiry;
  const [open, setOpen] = useState(false);
  const [many, setMany] = useState(kind === 'tags' ? ['a@b.test', 'c@d.test'] : ['bug', 'docs', 'ops']);
  const [answer, setAnswer] = useState('none');
  const [picked, setPicked] = useState('none');
  const disabled = state === 'disabled';
  const accessItems: MenuItem[] = [
    { key: 'private', label: <div>Only you<div className="fixture-detail">Turns the link off.</div></div>, icon: <LockOutlined />, selected: true },
    { key: 'public', label: <div>Anyone with the link<div className="fixture-detail">No sign-in needed to view.</div></div>, icon: <GlobalOutlined /> },
  ];
  // The submenus' second label: short, as long as an account name, or wider than a phone leaves beside its item.
  const claude = params.get('labels') === 'long' ? 'Claude Opus 5.5 with extended thinking (work)'
    : params.get('labels') === 'medium' ? 'Claude · work account' : 'Claude';
  const submenuItems = [{ key: 'provider', label: 'Provider', popupClassName: 'sample-submenu', children: [{ key: 'codex', label: 'Codex' }, { key: 'claude', label: claude }] }];
  const items = kind === 'access' ? accessItems : kind === 'submenu' ? submenuItems : attachmentItems;
  const menuClass = kind === 'access' ? 'fixture-access-menu share-access-menu' : kind === 'attachment' ? 'composer-attach-menu' : '';
  const trigger = <Button disabled={disabled}>{kind === 'access' ? 'Access' : 'Add attachment'}</Button>;
  return <SampleOwner legacy={legacy}><section className="choices-sample" aria-label="Appearance sample" style={anchor ? { position: 'fixed', padding: 0,
    top: anchor !== 'bottom' ? 12 : undefined, bottom: anchor === 'bottom' ? 12 : undefined,
    left: anchor === 'right' ? undefined : anchor === 'center' ? '45%' : 24, right: anchor === 'right' ? 12 : undefined } : undefined}>
    <div tabIndex={-1} data-testid="neutral">{['attachment', 'access', 'submenu'].includes(kind) ? legacy
      ? <Dropdown open={open} onOpenChange={setOpen} placement={calloutPlacement} trigger={['click']} disabled={disabled} menu={{ className: `sample-surface ${menuClass}`, selectedKeys: kind === 'access' ? ['private'] : [], items: kind === 'submenu' ? submenuItems : (items as MenuItem[]).map((entry) => entry.type === 'separator' ? { key: entry.key, type: 'divider' } : entry.type === 'group' ? null : { key: entry.key, label: entry.label, icon: entry.icon, disabled: entry.disabled }) }}>{trigger}</Dropdown>
      : <Menu open={open} onOpenChange={setOpen} side={side} align={align} trigger={trigger} disabled={disabled} items={items} variant={kind === 'attachment' ? 'attachment' : 'default'} popupClassName={`sample-surface ${menuClass}`} />
      // A workspace menu's shape: items around a submenu, one dangerous; same items and trigger for both systems.
      : kind === 'session' ? <>{legacy
        ? <Dropdown trigger={['click']} menu={{ onClick: ({ key }) => setPicked(key), items: [{ key: 'default', label: 'Default model' },
          { key: 'provider', label: 'Provider', children: [{ key: 'codex', label: 'Codex' }, { key: 'claude', label: claude }] },
          { key: 'separator', type: 'divider' }, { key: 'group', label: 'Group by tag' }, { key: 'delete', label: 'Delete', danger: true }] }}>
          <Button>Session actions</Button></Dropdown>
        : <Menu trigger={<Button>Session actions</Button>} items={[{ key: 'default', label: 'Default model', onSelect: () => setPicked('default') },
          { key: 'provider', label: 'Provider', children: [{ key: 'codex', label: 'Codex', onSelect: () => setPicked('codex') }, { key: 'claude', label: claude, onSelect: () => setPicked('claude') }] },
          { key: 'separator', type: 'separator' }, { key: 'group', label: 'Group by tag', onSelect: () => setPicked('group') },
          { key: 'delete', label: 'Delete', danger: true, onSelect: () => setPicked('delete') }]} />}
        <output aria-label="Picked">{picked}</output></>
      // The task panel's delete question, on the same trigger for both systems.
      : kind === 'popconfirm' ? <>{legacy
        ? <AntPopconfirm title="Delete this task?" description="A run still in flight is stopped. This action cannot be undone." okText="Delete" cancelText="Cancel"
          okButtonProps={{ danger: true }} classNames={{ container: 'sample-surface' }} onConfirm={() => setAnswer('confirmed')} onCancel={() => setAnswer('cancelled')}><Button>Delete task</Button></AntPopconfirm>
        : <Popconfirm trigger={<Button>Delete task</Button>} title="Delete this task?" description="A run still in flight is stopped. This action cannot be undone."
          confirmText="Delete" cancelText="Cancel" danger popupClassName="sample-surface" onConfirm={() => setAnswer('confirmed')} onCancel={() => setAnswer('cancelled')} />}
        <output aria-label="Answer">{answer}</output></>
      : kind === 'popover' ? legacy
        ? <AntPopover title="Context" content={<div>12,800 of 128,000 tokens</div>} trigger="click" placement={calloutPlacement} classNames={{ root: 'sample-floating-root', arrow: 'sample-arrow', container: 'sample-surface', title: 'sample-title' }}><Button>Context</Button></AntPopover>
        : <Popover trigger={<Button>Context</Button>} title="Context" side={side} align={align} popupClassName="sample-surface"><div>12,800 of 128,000 tokens</div></Popover>
      : kind === 'tooltip' ? legacy
        ? <AntTooltip title="Usage from this account" placement={calloutPlacement} classNames={{ root: 'sample-floating-root', arrow: 'sample-arrow', container: 'sample-surface' }}><Button>Usage</Button></AntTooltip>
        : <Tooltip content="Usage from this account" side={side} align={align} popupClassName="sample-surface"><Button>Usage</Button></Tooltip>
      : ['multiple', 'tags'].includes(kind) ? legacy
        ? <AntSelect aria-label="Sample choice" className="sample-choice" classNames={{ item: 'sample-chip', popup: { root: 'sample-surface' } }}
          placement={placement} mode={kind === 'tags' ? 'tags' : 'multiple'} size={kind === 'multiple' ? 'small' : 'middle'} value={many} onChange={setMany}
          options={kind === 'tags' ? [] : labels} maxTagCount={kind === 'multiple' ? 2 : undefined} disabled={disabled} allowClear showSearch optionFilterProp="label" virtual={false}
          open={kind === 'tags' ? false : undefined} tokenSeparators={[',', ' ']} />
        : <MultiSelect aria-label="Sample choice" className="sample-choice" popupClassName="sample-surface"
          side={side} mode={kind === 'tags' ? 'tags' : 'multiple'} size={kind === 'multiple' ? 'small' : 'middle'} value={many} onValueChange={setMany}
          options={kind === 'tags' ? [] : labels} maxTagCount={kind === 'multiple' ? 2 : undefined} disabled={disabled} clearable
          open={kind === 'tags' ? false : undefined} tokenSeparators={[',', ' ']} />
      : legacy
        ? <AntSelect placement={placement} aria-label="Sample choice" value={value ?? undefined} onChange={setValue} size={kind === 'expiry' ? 'small' : 'middle'}
          className="sample-choice" disabled={disabled} allowClear={kind === 'search'} showSearch={kind === 'search'} optionFilterProp="label" virtual={false}
          classNames={{ popup: { root: 'sample-surface' } }} options={choiceOptions}
          optionRender={kind === 'account' ? (option) => accountDetail(option.data) : undefined} />
        : kind === 'search'
          ? <Combobox side={side} aria-label="Sample choice" options={state === 'empty' ? [] : expiry} value={value} onValueChange={setValue} className="sample-choice" popupClassName="sample-surface" clearable disabled={disabled} />
          : <Select side={side} aria-label="Sample choice" options={choiceOptions} value={value} onValueChange={setValue}
            size={kind === 'expiry' ? 'small' : 'middle'} className="sample-choice" popupClassName="sample-surface" disabled={disabled} renderOption={kind === 'account' ? accountDetail : undefined} />}
    </div>
    {start !== null && <output aria-label="Sample value">{value ?? 'null'}</output>}
  </section></SampleOwner>;
}

/**
 * Where a sample is mounted, for the first-frame checks: on the page (default), or in an open dialog
 * or drawer (owner=dialog/drawer: Orbit's for Orbit samples, the replaced one for legacy samples, at
 * the same place). scroll puts a screen of content before and after the sample, in a scrolling box
 * on the page or in the owner, and pagescroll in the page itself; transform moves the owner (a box
 * around the sample on the page).
 */
function SampleOwner({ legacy, children }: { legacy: boolean; children: ReactNode }) {
  const params = new URLSearchParams(location.search);
  const owner = params.get('owner');
  const moved = params.has('transform') ? { transform: 'translate(16px, 8px)' } : undefined;
  const content = params.has('scroll') || params.has('pagescroll')
    ? <><div className="fixture-scroll-spacer" />{children}<div className="fixture-scroll-spacer" /></> : children;
  if (owner === 'dialog') return legacy
    ? <Modal open title="Sample owner" footer={null} closable={false} keyboard={false} maskClosable={false} style={moved}>{content}</Modal>
    : <Dialog open onClose={() => {}} title="Sample owner" closable={false} closeOnEscape={false} closeOnOutsideClick={false} style={moved}>{content}</Dialog>;
  if (owner === 'drawer') return legacy
    ? <AntDrawer open title="Sample owner" closable={false} keyboard={false} maskClosable={false} style={moved}>{content}</AntDrawer>
    : <Drawer open onClose={() => {}} title="Sample owner" closable={false} closeOnEscape={false} closeOnOutsideClick={false} style={moved}>{content}</Drawer>;
  if (params.has('scroll')) return <div className="fixture-scroll-owner">{content}</div>;
  return moved ? <div style={moved}>{content}</div> : content;
}

function ChoiceFields() {
  const [value, setValue] = useState<string | null>('never');
  const [workspace, setWorkspace] = useState<string | null>('orbit');
  const [checked, setChecked] = useState(false);
  const [action, setAction] = useState('none');
  const [dialog, setDialog] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  return <div className="choices-fields">
    <Select aria-label="Expires" options={expiry} value={value} onValueChange={setValue} clearable size="small" />
    <Combobox aria-label="Workspace" options={workspaces} value={workspace} onValueChange={setWorkspace} clearable placeholder="Choose workspace" />
    <Select aria-label="Disabled select" options={expiry} value="never" onValueChange={setValue} disabled />
    <Combobox aria-label="Disabled search" options={expiry} value="never" onValueChange={setValue} disabled />
    <Select aria-label="Empty select" options={[]} value={null} onValueChange={setValue} placeholder="No accounts" />
    <Select aria-label="Automatic account" options={accounts} value="" onValueChange={setValue} renderOption={accountDetail} />
    <Menu trigger={<Button ref={menuButton}>Session actions</Button>} items={[
      { type: 'group', key: 'models', label: 'Models', children: [
        { key: 'default', label: 'Default model', selected: true, onSelect: () => setAction('default') },
        { key: 'disabled', label: 'Unavailable model', disabled: true, onSelect: () => setAction('invalid') },
      ] },
      { key: 'provider', label: 'Provider', children: [{ key: 'codex', label: 'Codex', onSelect: () => setAction('codex') }, { key: 'claude', label: 'Claude', onSelect: () => setAction('claude') }] },
      { type: 'separator', key: 'sep' },
      { key: 'tag', label: 'Important tag', checked, onCheckedChange: setChecked },
      { key: 'dialog', label: 'Edit details', onSelect: () => setDialog(true) },
      { key: 'delete', label: 'Delete', danger: true, onSelect: () => setAction('delete') },
    ]} />
    <Menu trigger={<Button>Add attachment</Button>} items={attachmentItems.map((item) => item.type ? item : { ...item, onSelect: () => setAction(item.key) })} variant="attachment" />
    <Popover title="Context" trigger={<Button>Open context</Button>} openOnHover>
      <div>12,800 of 128,000 tokens</div>
      <Select aria-label="Context expiry" options={expiry} value={value} onValueChange={setValue} />
      <Input aria-label="Context note" />
    </Popover>
    <Tooltip content="Usage from this account"><Button>Account usage</Button></Tooltip>
    <Tooltip content="Runner is offline"><span tabIndex={0}><Button disabled>Unavailable action</Button></span></Tooltip>
    <Button>After choices</Button>
    <output aria-label="Expiry value">{value === null ? 'null' : value}</output>
    <output aria-label="Workspace value">{workspace === null ? 'null' : workspace}</output>
    <output aria-label="Action">{action}</output>
    <output aria-label="Tag">{String(checked)}</output>
    <Dialog open={dialog} onClose={() => setDialog(false)} title="Edit details" returnFocus={menuButton}><Input aria-label="Details" /></Dialog>
  </div>;
}

function RemoteChoice() {
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState('none');
  const generation = useRef(0);
  return <>
    <Combobox aria-label="Add prerequisite" value={null} onValueChange={(value) => setSelected(value ?? 'none')}
      options={options} filter={false} loading={loading} placeholder="Add a prerequisite…" onSearch={async (query) => {
        const current = ++generation.current;
        if (!query) { setOptions([]); setLoading(false); return; }
        setLoading(true);
        const response = await fetch(`/__choices-search?q=${encodeURIComponent(query)}`);
        const data = await response.json();
        if (current === generation.current) { setOptions(data); setLoading(false); }
      }} />
    <output aria-label="Prerequisite">{selected}</output>
  </>;
}

function MultiFields() {
  const [values, setValues] = useState(['bug']);
  const [emails, setEmails] = useState(['owner@orbit.test']);
  const [typing, setTyping] = useState('');
  return <div className="choices-fields">
    <MultiSelect aria-label="Labels" options={labels} value={values} onValueChange={setValues} clearable maxTagCount={2} size="small" />
    <MultiSelect aria-label="Disabled labels" options={labels} value={['bug']} onValueChange={setValues} disabled />
    <MultiSelect aria-label="People to add" options={[]} mode="tags" open={false} value={emails} onValueChange={setEmails}
      searchValue={typing} onSearch={setTyping} tokenSeparators={[',', ' ']} clearable />
    <Button>After tags</Button>
    <output aria-label="Labels value">{JSON.stringify(values)}</output>
    <output aria-label="People value">{JSON.stringify(emails)}</output>
    <output aria-label="People query">{typing}</output>
  </div>;
}

function MultiCases() {
  const [open, setOpen] = useState(false);
  const [rowClicks, setRowClicks] = useState(0);
  const [actions, setActions] = useState(0);
  return <section aria-label="Multiple choices">
    <MultiFields />
    <Button onClick={() => setOpen(true)}>Open multi Dialog</Button>
    <Dialog open={open} onClose={() => setOpen(false)} title="Multiple choices"><MultiFields /></Dialog>
    <div role="group" aria-label="Clickable row" onClick={() => setRowClicks((n) => n + 1)}>
      <Button>Open row</Button>
      <Menu trigger={<Button>Row actions</Button>} items={[{ key: 'run', label: 'Run action', onSelect: () => setActions((n) => n + 1) }]} />
    </div>
    <output aria-label="Row clicks">{rowClicks}</output><output aria-label="Row actions">{actions}</output>
    <Tooltip content="This account has a long usage explanation that wraps within the existing tooltip width and stays readable near a narrow screen edge."><Button>Long help</Button></Tooltip>
    <div className="fixture-mid-anchor"><Popover title="Plan usage" side="top" align="end" trigger={<Button>Plan usage panel</Button>}>
      <div className="cu-pop cu-pop-reset"><div>5-hour window · 12% used</div><div>Weekly window · 34% used</div><Button>Usage details</Button></div>
    </Popover></div>
  </section>;
}

function Content() {
  const { resolved, setMode } = useThemeMode();
  const [dialog, setDialog] = useState(false);
  const [legacy, setLegacy] = useState(false);
  return <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}><AntApp>
    <main className="choices-fixture">
      <output data-testid="theme">{resolved}</output>
      <Button onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}>Switch theme</Button>
      {new URLSearchParams(location.search).has('sample') ? <Samples /> : <>
        <Button onClick={() => setDialog(true)}>Open Dialog</Button>
        <Button onClick={() => setLegacy(true)}>Open legacy Modal</Button>
        <section aria-label="Standalone choices"><ChoiceFields /><RemoteChoice /></section>
        <MultiCases />
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Share workspace"><ChoiceFields /></Dialog>
        <Modal open={legacy} onCancel={() => setLegacy(false)} title="Legacy share" footer={null} destroyOnHidden rootClassName="legacy-choices-owner">
        {new URLSearchParams(location.search).has('legacyBaseline')
          ? <><AntSelect aria-label="Legacy expiry" options={expiry} defaultValue="never" /><AntButton>After choices</AntButton></>
          : <OverlayScope><ChoiceFields /></OverlayScope>}
        </Modal>
      </>}
    </main>
  </AntApp></ConfigProvider>;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
export function ChoicesFixture() {
  return <QueryClientProvider client={client}><ThemeProvider><Content /></ThemeProvider></QueryClientProvider>;
}
