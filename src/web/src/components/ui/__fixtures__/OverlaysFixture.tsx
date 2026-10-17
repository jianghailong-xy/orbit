import { useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider, useThemeMode } from '../../../lib/theme';
import { useToast } from '../../../lib/toast';
import { ToastViewport } from '../../ToastViewport';
import { AppRoot } from '../AppRoot';
import { Button } from '../Button';
import { Input } from '../Input';
import { Dialog } from '../Dialog';
import { Drawer } from '../Drawer';
import { ConfirmDialog, useConfirm } from '../ConfirmDialog';
import './OverlaysFixture.css';

const description = 'Changes apply to this workspace. Review the details before saving.';

function ThemeSwitch() {
  const { resolved, setMode } = useThemeMode();
  return <Button onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}>Switch theme</Button>;
}

function AsyncConfirm({ onResult }: { onResult: (result: string) => void }) {
  const [confirm, holder] = useConfirm();
  const [attempts, setAttempts] = useState(0);
  const [result, setResult] = useState('none');
  const requests = useRef(0);
  return <section aria-label="Async confirmation">
    <Button onClick={() => {
      const options = { title: 'Delete runner?', description: 'This removes the runner from your account.', confirmText: 'Delete', danger: true,
        onConfirm: async () => {
          const attempt = ++requests.current;
          setAttempts(attempt);
          const response = await fetch(`/__overlay-confirm?attempt=${attempt}`, { method: 'POST' });
          if (!response.ok) throw new Error('Runner is busy. Try again.');
        } };
      const promise = confirm(options);
      // Duplicate requests from the same handler must share the existing prompt.
      if (confirm(options) !== promise) throw new Error('Duplicate confirmation');
      void promise.then((value) => {
        setResult(value ? 'confirmed' : 'cancelled');
        onResult(value ? 'confirmed' : 'cancelled');
      });
    }}>Delete runner</Button>
    <Button onClick={async () => {
      if (await confirm({ title: 'First confirmation', onConfirm: () => {} })) {
        await confirm({ title: 'Second confirmation', onConfirm: () => { throw new Error('Second action failed'); } });
      }
    }}>Sequential confirmations</Button>
    <output aria-label="Attempts">{attempts}</output><output aria-label="Result">{result}</output>
    {holder}
  </section>;
}

function NestedContent() {
  const [nested, setNested] = useState(false);
  const [confirm, holder] = useConfirm();
  return <>
    <Input aria-label="Parent name" />
    <Button onClick={() => setNested(true)}>Open nested dialog</Button>
    <Dialog open={nested} onClose={() => setNested(false)} title="Nested dialog" description="Only the top layer should close.">
      <Input aria-label="Nested name" />
      <Button onClick={() => setNested(false)}>Done nested</Button>
    </Dialog>
    <Button onClick={() => void confirm({ title: 'Discard draft?', description: 'Your draft will be discarded.', onConfirm: () => {} })}>Discard draft</Button>
    {holder}
    <ThemeSwitch />
  </>;
}

function SampleBody() {
  return <label>Workspace name<Input defaultValue="Orbit workspace" /></label>;
}

function Samples() {
  const [current, setCurrent] = useState('');
  const close = () => setCurrent('');
  const footer = <><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={close}>Save</Button></>;
  return <section aria-label="Appearance reference" className="overlays-fixture-actions">
    {['dialog', 'right drawer', 'bottom drawer', 'confirm'].map((kind) => {
      const name = `Orbit ${kind}`;
      return <Button key={name} onClick={() => setCurrent(name)}>{name}</Button>;
    })}
    <Dialog open={current === 'Orbit dialog'} onClose={close} title="Edit workspace" footer={footer}>
      <SampleBody />
    </Dialog>
    {(['right', 'bottom'] as const).map((placement) => <div key={placement}>
      <Drawer open={current === `Orbit ${placement} drawer`} onClose={close} title="Edit workspace" placement={placement} footer={footer}>
        <SampleBody />
      </Drawer>
    </div>)}
    <ConfirmDialog open={current === 'Orbit confirm'} onClose={close} title="Delete runner?"
      description="This removes the runner from your account." confirmText="Delete" danger onConfirm={() => {}} />
  </section>;
}

/** A control that gives way to what it opens, as a card's "Not yet" gives way to its note. */
function GivesWay() {
  const [pressed, setPressed] = useState(false);
  return pressed ? <p>The note goes here.</p> : <Button onClick={() => setPressed(true)}>Not yet</Button>;
}

function Content() {
  const { resolved } = useThemeMode();
  const [open, setOpen] = useState('');
  const [hostMounted, setHostMounted] = useState(true);
  const [lastResult, setLastResult] = useState('none');
  const initialInput = useRef<HTMLInputElement>(null);
  const focusTrigger = useRef<HTMLButtonElement>(null);
  const close = () => setOpen('');
  // The app's root (AppRoot, as main.tsx draws it).
  return <AppRoot>
    <main className="overlays-fixture">
      <h1>Orbit overlays</h1><output data-testid="theme">{resolved}</output>
      <div className="overlays-fixture-actions">
        {['Dialog', 'Drawer', 'Bottom sheet', 'Protected', 'Retained', 'Long dialog'].map((name) =>
          <Button key={name} onClick={() => setOpen(name)}>Open {name}</Button>)}
        <Button onClick={() => setHostMounted((value) => !value)}>Toggle confirmation host</Button>
        <Button ref={focusTrigger} onClick={() => setOpen('Focus')}>Edit name</Button>
      </div>
      <output aria-label="Last confirmation result">{lastResult}</output>
      {hostMounted && <AsyncConfirm onResult={setLastResult} />}
      <Samples />
      <Dialog open={open === 'Dialog'} onClose={close} title="Workspace dialog" description={description}><NestedContent /></Dialog>
      <Drawer open={open === 'Drawer'} onClose={close} title="Workspace drawer"><NestedContent /></Drawer>
      <Drawer open={open === 'Bottom sheet'} onClose={close} title="Footnote" placement="bottom" height="auto">
        <p>Fixed footnote content.</p><Button onClick={close}>Done sheet</Button>
      </Drawer>
      <Dialog open={open === 'Protected'} onClose={close} title="Protected dialog" closable={false}
        closeOnEscape={false} closeOnOutsideClick={false}><Button onClick={close}>Done protected</Button></Dialog>
      <Dialog open={open === 'Retained'} onClose={close} title="Retained dialog" keepMounted><Input aria-label="Retained value" /></Dialog>
      <Dialog open={open === 'Focus'} onClose={close} title="Edit name" initialFocus={initialInput} returnFocus={focusTrigger}
        footer={<Button type="submit" form="overlay-name-form">Save name</Button>}>
        <form id="overlay-name-form" onSubmit={(event) => { event.preventDefault(); close(); }}>
          <label>Name<Input ref={initialInput} required /></label>
        </form>
      </Dialog>
      <Dialog open={open === 'Long dialog'} onClose={close} title="Long dialog" footer={<Button onClick={close}>Done long</Button>}>
        <GivesWay />
        {Array.from({ length: 45 }, (_, i) => <p key={i}>Paragraph {i + 1}: fixed scrollable dialog content.</p>)}
      </Dialog>
      <div className="overlays-fixture-spacer">Page scroll target</div>
    </main>
  </AppRoot>;
}

// A card the way the providers, pools and runners pages build theirs: the app's .re-card size container,
// its height set by its rows. Around such cards WebKit drops .app-view's scroll position when the
// document's own scrollbar changes mode.
function PageCard({ name }: { name: string }) {
  return <div className="re-card">{Array.from({ length: 40 }, (_, i) => <p key={i}>{name}, row {i + 1}</p>)}</div>;
}

// The app's page frame (main.tsx, AppShell's DocView): html, body and #root are one viewport high and
// the page scrolls inside .app-view, so the document itself never scrolls. A notice goes through
// lib/toast to the app's ToastViewport and leaves the screen-reader live region at the end of <body>.
function AppFrame() {
  const { resolved } = useThemeMode();
  const toast = useToast();
  return <AppRoot><BrowserRouter>
    <div className="app-shell"><main className="app-main"><div className="app-view app-view--doc">
      <h1>Orbit overlays in the app frame</h1><output data-testid="theme">{resolved}</output>
      <PageCard name="Card above the overlays" />
      <div className="overlays-fixture-actions">
        <Button onClick={() => toast.success('Workspace saved')}>Show notice</Button>
        <Button onClick={() => toast.destroy()}>Clear notifications</Button>
      </div>
      <Samples />
      <PageCard name="Card below the overlays" />
    </div></main></div>
    <ToastViewport />
  </BrowserRouter></AppRoot>;
}

export function OverlaysFixture() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  // overlays.html?app-frame: the reference overlays inside the app's page frame.
  const appFrame = new URLSearchParams(window.location.search).has('app-frame');
  return <QueryClientProvider client={client}><ThemeProvider>{appFrame ? <AppFrame /> : <Content />}</ThemeProvider></QueryClientProvider>;
}
