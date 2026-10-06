import { useState } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { ThemeProvider, useThemeMode } from '../../../lib/theme';
import { darkTheme, lightTheme } from '../../../theme';
import { useToast } from '../../../lib/toast';
import { ToastViewport } from '../../ToastViewport';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Drawer } from '../Drawer';
import { useConfirm } from '../ConfirmDialog';

const sessionId = '0196b000-0000-7000-8000-000000000001';
const sessionTitle = 'Fix login redirect';

function Actions() {
  const toast = useToast();
  const { resolved, setMode } = useThemeMode();
  const [undone, setUndone] = useState(0);
  const [confirm, holder] = useConfirm();
  const [child, setChild] = useState(false);
  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Button onClick={() => toast.success('Link copied')}>Short notice</Button>
      <Button onClick={() => toast.error("Couldn't save the schedule", 'revision 12 is stale')}>Error notice</Button>
      <Button onClick={() => toast.warning('Waiting for your approval', 'Review the changes before continuing.')}>Warning notice</Button>
      <Button onClick={() => toast.sessionAction({ sessionId, sessionTitle, action: 'complete', onUndo: () => setUndone((n) => n + 1) })}>Complete session</Button>
      <Button onClick={() => toast.sessionNotice({ sessionId, sessionTitle, event: 'merge', headline: 'Merged into main' })}>Session result</Button>
      <Button onClick={() => toast.sessionNotice({ sessionId, sessionTitle, event: 'merge', headline: "Couldn't merge into main", tone: 'error', detail: 'CONFLICT (content): src/app.ts' })}>Session failure</Button>
      <Button onClick={() => toast.destroy()}>Clear notifications</Button>
      <Button onClick={() => setMode(resolved === 'light' ? 'dark' : 'light')}>Switch theme</Button>
      <Button onClick={() => setChild(true)}>Nested dialog</Button>
      <Button onClick={() => void confirm({ title: 'Save schedule?', confirmText: 'Save', description: 'Save this workspace schedule.',
        onConfirm: async () => {
          const response = await fetch('/__toast-confirm', { method: 'POST' });
          if (!response.ok) {
            toast.error("Couldn't save the schedule", 'revision 12 is stale');
            throw new Error('revision 12 is stale');
          }
          toast.success('Schedule saved');
        } })}>Confirm save</Button>
    </div>
    <output aria-label="Undo count">{undone}</output>
    <Dialog open={child} onClose={() => setChild(false)} title="Nested editor"><Actions /></Dialog>
    {holder}
  </>;
}

function LegacyConfirm() {
  const { modal } = AntApp.useApp();
  const toast = useToast();
  return <Button onClick={() => modal.confirm({ title: 'Legacy confirmation', onOk: () => toast.success('Legacy confirmed') })}>Legacy confirm</Button>;
}

function Content() {
  const { resolved } = useThemeMode();
  const [open, setOpen] = useState('');
  const location = useLocation();
  return <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}><AntApp>
    <main style={{ padding: '240px 24px 24px', minHeight: '150vh', color: 'var(--text-1)' }}>
      <h1>Notification integration</h1>
      <output data-testid="theme">{resolved}</output><output aria-label="Location">{location.pathname}</output>
      <Actions />
      <Button onClick={() => setOpen('Dialog')}>Open Dialog</Button>
      <Button onClick={() => setOpen('Drawer')}>Open Drawer</Button>
      <Button onClick={() => setOpen('Bottom drawer')}>Open Bottom drawer</Button>
      <LegacyConfirm />
      <Dialog open={open === 'Dialog'} onClose={() => setOpen('')} title="Workspace editor"><Actions /></Dialog>
      <Drawer open={open === 'Drawer'} onClose={() => setOpen('')} title="Workspace drawer"><Actions /></Drawer>
      <Drawer open={open === 'Bottom drawer'} onClose={() => setOpen('')} placement="bottom" height="auto" title="Workspace sheet"><Actions /></Drawer>
    </main>
    <ToastViewport />
  </AntApp></ConfigProvider>;
}

export function ToastsFixture() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}><ThemeProvider><BrowserRouter><Content /></BrowserRouter></ThemeProvider></QueryClientProvider>;
}
