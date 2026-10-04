import { useState, type ReactNode } from 'react';
import { App as AntApp, Tag as AntTag, Button as AntButton, Checkbox as AntCheckbox,
  ConfigProvider, Input as AntInput, Radio as AntRadio, Spin as AntSpin, Switch as AntSwitch } from 'antd';
import { PlusOutlined, SearchOutlined, InfoCircleOutlined } from '@ant-design/icons';
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
      <Behavior />
    </main>
  </AntApp></ConfigProvider>;
}

export function ControlsFixture() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}><ThemeProvider><Content /></ThemeProvider></QueryClientProvider>;
}
