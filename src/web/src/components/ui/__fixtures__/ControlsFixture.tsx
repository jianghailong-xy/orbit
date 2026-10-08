import { useState, type ReactNode } from 'react';
import { App as AntApp, Tag as AntTag, Button as AntButton, Checkbox as AntCheckbox,
  ConfigProvider, Input as AntInput, Radio as AntRadio, Spin as AntSpin, Switch as AntSwitch,
  Alert as AntAlert, Card as AntCard, Empty as AntEmpty, List as AntList, Skeleton as AntSkeleton,
  Typography as AntTypography } from 'antd';
import { CopyOutlined, DownOutlined, PlusOutlined, SearchOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useThemeMode } from '../../../lib/theme';
import { darkTheme, lightTheme } from '../../../theme';
import { Button, LinkButton } from '../Button';
import { Input } from '../Input';
import { Textarea } from '../Textarea';
import { Checkbox } from '../Checkbox';
import { Radio, RadioGroup } from '../Radio';
import { Switch } from '../Switch';
import { Badge } from '../Badge';
import { Spinner } from '../Spinner';
import { Alert } from '../Alert';
import { Card } from '../Card';
import { Empty } from '../Empty';
import { Skeleton } from '../Skeleton';
import '../Typography.css';
import '../List.css';
import './ControlsFixture.css';

function Pair({ name, orbit, ant }: { name: string; orbit: ReactNode; ant: ReactNode }) {
  return <section className="controls-case" data-case={name} aria-label={name}>
    <h3>{name}</h3>
    <div className="controls-cell" data-side="orbit"><span className="controls-source">Orbit</span>{orbit}</div>
    <div className="controls-cell" data-side="ant"><span className="controls-source">AntD</span>{ant}</div>
  </section>;
}

function Behavior() {
  const [presses, setPresses] = useState(0);
  const [checked, setChecked] = useState(false);
  const [choice, setChoice] = useState<string | number>('one');
  const [enabled, setEnabled] = useState(false);
  const [externalChoice, setExternalChoice] = useState('one');
  const [submitted, setSubmitted] = useState('');
  return <section className="controls-behavior" aria-label="Interactive controls">
    <h2 id="fixture-link-target">Keyboard and form behavior</h2>
    <div className="controls-actions">
      <Button onClick={() => setPresses((value) => value + 1)}>Activate</Button>
      <Button disabled onClick={() => setPresses((value) => value + 1)}>Disabled action</Button>
      <Button loading onClick={() => setPresses((value) => value + 1)}>Loading action</Button>
      <output aria-label="Activation count">{presses}</output>
      <LinkButton href="#fixture-link-target">Open target</LinkButton>
    </div>
    <Checkbox checked={checked} onCheckedChange={setChecked}>Controlled checkbox</Checkbox>
    <RadioGroup aria-label="Controlled choice" value={choice} onValueChange={setChoice}>
      <Radio value="one">First choice</Radio><Radio value="unavailable" disabled>Unavailable choice</Radio><Radio value="two">Second choice</Radio>
    </RadioGroup>
    <Switch aria-label="Controlled switch" checked={enabled} onCheckedChange={setEnabled} />
    <Switch checked={false} aria-label="Loading switch" loading onCheckedChange={() => setPresses((value) => value + 1)} />
    <div className="controls-actions">
      <label htmlFor="external-checkbox">External checkbox</label>
      <Checkbox id="external-checkbox" checked={checked} onCheckedChange={setChecked} />
      <Checkbox checked={checked} onCheckedChange={setChecked} aria-label="Explicit checkbox name">Visible checkbox text</Checkbox>
    </div>
    <div className="controls-actions">
      <label htmlFor="external-radio-one">External radio one</label>
      <label htmlFor="external-radio-two">External radio two</label>
      <RadioGroup aria-label="External labels" value={externalChoice} onValueChange={setExternalChoice}>
        <Radio id="external-radio-one" value="one" /><Radio id="external-radio-two" value="two" />
      </RadioGroup>
    </div>
    <form aria-label="Native form" onSubmit={(event) => {
      event.preventDefault();
      setSubmitted(JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))));
    }}>
      <label className="controls-field">Project name<Input name="project" defaultValue="Orbit" required /></label>
      <label className="controls-field">Description<Textarea name="description" defaultValue="Fixed text" rows={2} /></label>
      <Checkbox name="accepted" value="yes" checked={checked} onCheckedChange={setChecked}>Accept updates</Checkbox>
      <Checkbox name="disabled" value="excluded" disabled checked>Disabled field</Checkbox>
      <RadioGroup name="mode" aria-label="Form mode" value={choice} onValueChange={setChoice}>
        <Radio value="one">Manual mode</Radio><Radio value="two">Automatic mode</Radio>
      </RadioGroup>
      <Switch name="notifications" value="enabled" aria-label="Notifications" checked={enabled} onCheckedChange={setEnabled} />
      <div className="controls-actions"><Button type="submit">Submit form</Button><Button type="reset">Reset form</Button></div>
    </form>
    <output aria-label="Submitted values">{submitted}</output>
  </section>;
}

function Content() {
  const { resolved } = useThemeMode();
  return <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}><AntApp>
    <main className="controls-page">
      <h1>Orbit basic controls</h1>
      <p data-testid="theme">Theme: {resolved}</p>
      <p>Fixed labels and values. Each pair shares the existing theme provider, reset, font and surface.</p>
      <h2>Buttons</h2>
      {(['small', 'middle', 'large'] as const).map((size) => <Pair key={size} name={`button-${size}`}
        orbit={<Button size={size}>Save changes</Button>} ant={<AntButton size={size}>Save changes</AntButton>} />)}
      {(['primary', 'text', 'link'] as const).map((variant) => <Pair key={variant} name={`button-${variant}`}
        orbit={<Button variant={variant}>Save changes</Button>} ant={<AntButton type={variant}>Save changes</AntButton>} />)}
      {(['default', 'primary', 'text'] as const).map((variant) => <Pair key={variant} name={`button-danger-${variant}`}
        orbit={<Button variant={variant} danger>Delete</Button>} ant={<AntButton type={variant} danger>Delete</AntButton>} />)}
      <Pair name="button-icon" orbit={<Button icon={<PlusOutlined />}>Create</Button>} ant={<AntButton icon={<PlusOutlined />}>Create</AntButton>} />
      <Pair name="button-icon-only" orbit={<Button icon={<PlusOutlined />} aria-label="Create" />} ant={<AntButton icon={<PlusOutlined />} aria-label="Create" />} />
      <Pair name="button-icon-end" orbit={<Button size="small" variant="text" icon={<DownOutlined />} iconPlacement="end">Expand</Button>}
        ant={<AntButton size="small" type="text">Expand <DownOutlined /></AntButton>} />
      <Pair name="button-disabled" orbit={<Button variant="primary" disabled>Save changes</Button>} ant={<AntButton type="primary" disabled>Save changes</AntButton>} />
      {(['default', 'text', 'link'] as const).map((variant) => <Pair key={variant} name={`button-disabled-${variant}`}
        orbit={<Button variant={variant} disabled>Save changes</Button>} ant={<AntButton type={variant} disabled>Save changes</AntButton>} />)}
      <Pair name="button-disabled-danger" orbit={<Button variant="primary" danger disabled>Delete</Button>} ant={<AntButton type="primary" danger disabled>Delete</AntButton>} />
      <Pair name="button-disabled-danger-text" orbit={<Button variant="text" danger disabled>Delete</Button>} ant={<AntButton type="text" danger disabled>Delete</AntButton>} />
      <Pair name="button-loading" orbit={<Button variant="primary" loading>Save changes</Button>} ant={<AntButton type="primary" loading>Save changes</AntButton>} />
      <h2>Text fields</h2>
      {(['small', 'middle', 'large'] as const).map((size) => <Pair key={size} name={`input-${size}`}
        orbit={<Input aria-label="Project" size={size} defaultValue="Orbit baseline" />} ant={<AntInput aria-label="Project" size={size} defaultValue="Orbit baseline" />} />)}
      <Pair name="input-affix" orbit={<Input aria-label="Search" prefix={<SearchOutlined />} suffix={<InfoCircleOutlined />} placeholder="Search projects" />} ant={<AntInput aria-label="Search" prefix={<SearchOutlined />} suffix={<InfoCircleOutlined />} placeholder="Search projects" />} />
      <Pair name="input-invalid" orbit={<Input aria-label="Invalid project" invalid defaultValue="Missing owner" />} ant={<AntInput aria-label="Invalid project" status="error" defaultValue="Missing owner" />} />
      <Pair name="input-warning" orbit={<Input aria-label="Merge check" warning placeholder="npm test" />} ant={<AntInput aria-label="Merge check" status="warning" placeholder="npm test" />} />
      <Pair name="input-disabled" orbit={<Input aria-label="Disabled project" disabled defaultValue="Orbit baseline" />} ant={<AntInput aria-label="Disabled project" disabled defaultValue="Orbit baseline" />} />
      <Pair name="textarea" orbit={<Textarea aria-label="Description" rows={3} defaultValue={'First line\nSecond line'} />} ant={<AntInput.TextArea aria-label="Description" rows={3} defaultValue={'First line\nSecond line'} />} />
      <Pair name="textarea-invalid" orbit={<Textarea aria-label="Invalid description" invalid rows={2} defaultValue="Missing detail" />} ant={<AntInput.TextArea aria-label="Invalid description" status="error" rows={2} defaultValue="Missing detail" />} />
      <Pair name="textarea-disabled" orbit={<Textarea aria-label="Disabled description" disabled rows={2} defaultValue="Read only" />} ant={<AntInput.TextArea aria-label="Disabled description" disabled rows={2} defaultValue="Read only" />} />
      <h2>Selection</h2>
      <Pair name="checkbox" orbit={<Checkbox checked={false}>Include tasks</Checkbox>} ant={<AntCheckbox>Include tasks</AntCheckbox>} />
      <Pair name="checkbox-checked" orbit={<Checkbox checked>Include tasks</Checkbox>} ant={<AntCheckbox defaultChecked>Include tasks</AntCheckbox>} />
      <Pair name="checkbox-mixed" orbit={<Checkbox checked={false} indeterminate>Include tasks</Checkbox>} ant={<AntCheckbox indeterminate>Include tasks</AntCheckbox>} />
      <Pair name="checkbox-disabled" orbit={<Checkbox disabled checked>Include tasks</Checkbox>} ant={<AntCheckbox disabled defaultChecked>Include tasks</AntCheckbox>} />
      <Pair name="radio" orbit={<RadioGroup value="manual"><Radio value="manual">Manual</Radio><Radio value="auto">Auto</Radio><Radio value="off" disabled>Off</Radio></RadioGroup>}
        ant={<AntRadio.Group defaultValue="manual"><AntRadio value="manual">Manual</AntRadio><AntRadio value="auto">Auto</AntRadio><AntRadio value="off" disabled>Off</AntRadio></AntRadio.Group>} />
      {(['small', 'middle'] as const).map((size) => <Pair key={size} name={`radio-button-${size}`}
        orbit={<RadioGroup variant="button" size={size} value="manual"><Radio value="manual">Manual</Radio><Radio value="auto">Auto</Radio><Radio value="off" disabled>Off</Radio></RadioGroup>}
        ant={<AntRadio.Group size={size} defaultValue="manual"><AntRadio.Button value="manual">Manual</AntRadio.Button><AntRadio.Button value="auto">Auto</AntRadio.Button><AntRadio.Button value="off" disabled>Off</AntRadio.Button></AntRadio.Group>} />)}
      {(['small', 'middle'] as const).map((size) => <Pair key={size} name={`switch-${size}`}
        orbit={<Switch size={size} aria-label="Notifications" checked />} ant={<AntSwitch size={size === 'middle' ? 'medium' : size} aria-label="Notifications" defaultChecked />} />)}
      <Pair name="switch-off" orbit={<Switch checked={false} aria-label="Notifications" />} ant={<AntSwitch aria-label="Notifications" />} />
      <Pair name="switch-disabled" orbit={<Switch aria-label="Notifications" disabled checked />} ant={<AntSwitch aria-label="Notifications" disabled defaultChecked />} />
      <Pair name="switch-loading" orbit={<Switch aria-label="Notifications" loading checked />} ant={<AntSwitch aria-label="Notifications" loading defaultChecked />} />
      <h2>Status</h2>
      {(['default', 'info', 'success', 'warning', 'error', 'blue'] as const).map((tone) => <Pair key={tone} name={`badge-${tone}`}
        orbit={<Badge tone={tone}>Task status</Badge>} ant={<AntTag color={tone === 'info' ? 'processing' : tone}>Task status</AntTag>} />)}
      <Pair name="badge-icon" orbit={<Badge tone="success" icon={<InfoCircleOutlined />}>Task status</Badge>} ant={<AntTag color="success" icon={<InfoCircleOutlined />}>Task status</AntTag>} />
      {(['small', 'middle'] as const).map((size) => <Pair key={size} name={`spinner-${size}`}
        orbit={<Spinner size={size} />} ant={<AntSpin size={size === 'middle' ? 'medium' : size} />} />)}
      <Pair name="badge-purple" orbit={<Badge tone="purple">Awaiting verification</Badge>} ant={<AntTag color="purple">Awaiting verification</AntTag>} />
      <h2>Feedback, cards and text (P4.3a)</h2>
      <Pair name="alert-action" orbit={<Alert type="error" title="Tasks could not be loaded" action={<Button size="small" danger>Retry</Button>} />}
        ant={<AntAlert type="error" showIcon message="Tasks could not be loaded" action={<AntButton size="small" danger>Retry</AntButton>} />} />
      <Pair name="alert-action-description" orbit={<Alert type="error" title="Projects could not be loaded" description="The server answered 503." action={<Button size="small" danger>Retry</Button>} />}
        ant={<AntAlert type="error" showIcon message="Projects could not be loaded" description="The server answered 503." action={<AntButton size="small" danger>Retry</AntButton>} />} />
      <Pair name="alert-warning-description" orbit={<Alert type="warning" title="Impact ranking not computed" description="More than 500 unfinished tasks." />}
        ant={<AntAlert type="warning" showIcon message="Impact ranking not computed" description="More than 500 unfinished tasks." />} />
      <Pair name="card-small" orbit={<Card title="Attribution" size="small" style={{ width: 280 }}>Counts towards Orbit UI migration</Card>}
        ant={<AntCard title="Attribution" size="small" style={{ width: 280 }}>Counts towards Orbit UI migration</AntCard>} />
      <Pair name="card-extra" orbit={<Card title="Acceptance criteria" extra={<Button size="small">Edit</Button>} style={{ width: 320 }}>Three criteria stated.</Card>}
        ant={<AntCard title="Acceptance criteria" extra={<AntButton size="small">Edit</AntButton>} style={{ width: 320 }}>Three criteria stated.</AntCard>} />
      <Pair name="empty-default" orbit={<Empty description="No open projects" style={{ width: 300 }}><Button variant="primary" icon={<PlusOutlined />}>New project</Button></Empty>}
        ant={<AntEmpty description="No open projects" style={{ width: 300 }}><AntButton type="primary" icon={<PlusOutlined />}>New project</AntButton></AntEmpty>} />
      <Pair name="empty-simple" orbit={<Empty image="simple" description="No subtasks" style={{ width: 300 }} />}
        ant={<AntEmpty image={AntEmpty.PRESENTED_IMAGE_SIMPLE} description="No subtasks" style={{ width: 300 }} />} />
      {([3, 2] as const).map((rows) => <Pair key={rows} name={`skeleton-${rows}`} orbit={<div style={{ width: 300 }}><Skeleton rows={rows} /></div>}
        ant={<div style={{ width: 300 }}><AntSkeleton active title={false} paragraph={{ rows }} /></div>} />)}
      <Pair name="typography-title-2" orbit={<h2 className="orbit-typography">Orbit UI migration</h2>} ant={<AntTypography.Title level={2}>Orbit UI migration</AntTypography.Title>} />
      <Pair name="typography-title-4" orbit={<h4 className="orbit-typography">Run queue</h4>} ant={<AntTypography.Title level={4}>Run queue</AntTypography.Title>} />
      <Pair name="typography-title-5" orbit={<h5 className="orbit-typography">Goal</h5>} ant={<AntTypography.Title level={5}>Goal</AntTypography.Title>} />
      <Pair name="typography-paragraph" orbit={<div className="orbit-typography orbit-typography-secondary">No instructions set</div>}
        ant={<AntTypography.Paragraph type="secondary">No instructions set</AntTypography.Paragraph>} />
      <Pair name="typography-paragraph-strong" orbit={<div className="orbit-typography"><strong>2 unfinished tasks stay filed under it.</strong></div>}
        ant={<AntTypography.Paragraph strong>2 unfinished tasks stay filed under it.</AntTypography.Paragraph>} />
      <Pair name="typography-secondary" orbit={<span className="orbit-typography orbit-typography-secondary">Next → Capture browser baselines</span>}
        ant={<AntTypography.Text type="secondary">Next → Capture browser baselines</AntTypography.Text>} />
      <Pair name="typography-warning" orbit={<span className="orbit-typography orbit-typography-warning">Not on main yet</span>}
        ant={<AntTypography.Text type="warning">Not on main yet</AntTypography.Text>} />
      <Pair name="typography-strong" orbit={<span className="orbit-typography"><strong>Orbit UI migration</strong></span>}
        ant={<AntTypography.Text strong>Orbit UI migration</AntTypography.Text>} />
      <Pair name="typography-code" orbit={<span className="orbit-typography"><code>RUN_ACCEPTANCE_COMMAND</code></span>}
        ant={<AntTypography.Text code>RUN_ACCEPTANCE_COMMAND</AntTypography.Text>} />
      <Pair name="typography-code-copy" orbit={<span className="orbit-typography"><code>34ZZeq0e3IR65GVm2kAs7<span className="orbit-typography-actions"><button type="button" className="orbit-typography-copy" aria-label="Copy"><CopyOutlined aria-hidden /></button></span></code></span>}
        ant={<AntTypography.Text code copyable={{ text: '34ZZeq0e3IR65GVm2kAs7' }}>34ZZeq0e3IR65GVm2kAs7</AntTypography.Text>} />
      {(['default', 'small'] as const).map((size) => <Pair key={size} name={`list-${size}`}
        orbit={<div className={`orbit-list orbit-list-split${size === 'small' ? ' orbit-list-sm' : ''}`} style={{ width: 320 }}><ul className="orbit-list-items">
          {['Inventory existing components', 'Capture browser baselines'].map((title) => <li key={title} className="orbit-list-item">
            <div className="orbit-list-item-meta"><div className="orbit-list-item-meta-content">
              <h4 className="orbit-list-item-meta-title">{title}</h4>
              <div className="orbit-list-item-meta-description">No acceptance criteria set</div>
            </div></div>
          </li>)}
        </ul></div>}
        ant={<AntList size={size} style={{ width: 320 }} dataSource={['Inventory existing components', 'Capture browser baselines']} rowKey={(title) => title}
          renderItem={(title) => <AntList.Item><AntList.Item.Meta title={title} description="No acceptance criteria set" /></AntList.Item>} />} />)}
      <Pair name="input-clear" orbit={<Input aria-label="Search projects" prefix={<SearchOutlined />} allowClear value="" onChange={() => undefined} placeholder="Search projects and goals" />}
        ant={<AntInput aria-label="Search projects" prefix={<SearchOutlined />} allowClear value="" onChange={() => undefined} placeholder="Search projects and goals" />} />
      <Pair name="input-clear-value" orbit={<Input aria-label="Search tasks" size="small" prefix={<SearchOutlined />} allowClear value="baseline" onChange={() => undefined} />}
        ant={<AntInput aria-label="Search tasks" size="small" prefix={<SearchOutlined />} allowClear value="baseline" onChange={() => undefined} />} />
      <Behavior />
    </main>
  </AntApp></ConfigProvider>;
}

export function ControlsFixture() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}><ThemeProvider><Content /></ThemeProvider></QueryClientProvider>;
}
