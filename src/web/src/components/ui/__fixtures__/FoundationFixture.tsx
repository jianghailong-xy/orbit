import { useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { App as AntApp, Button as AntButton, ConfigProvider, Modal } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useThemeMode } from '../../../lib/theme';
import { darkTheme, lightTheme } from '../../../theme';
import './FoundationFixture.css';

// Private browser fixture: this is not the public Button or Dialog contract.
function OrbitDialog({ nested = false }: { nested?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  return (
    <div ref={container}>
      <Dialog.Root>
        <Dialog.Trigger className="foundation-control">
          {nested ? 'Open nested Orbit dialog' : 'Open Orbit dialog'}
        </Dialog.Trigger>
        {/* Keep the nested portal inside AntD's focus boundary. */}
        <Dialog.Portal container={nested ? container : undefined}>
          <Dialog.Backdrop className="foundation-backdrop" />
          <Dialog.Viewport className="foundation-dialog-viewport">
            <Dialog.Popup className="foundation-dialog">
              <Dialog.Title className="foundation-dialog-title">
                {nested ? 'Nested Orbit dialog' : 'Orbit dialog'}
              </Dialog.Title>
              <Dialog.Description>
                Shared theme tokens with native keyboard focus and dismissal.
              </Dialog.Description>
              <div className="foundation-controls">
                <Button className="foundation-control">Dialog action</Button>
                <Dialog.Close className="foundation-control">Close Orbit dialog</Dialog.Close>
              </div>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function Content() {
  const { mode, resolved, setMode } = useThemeMode();
  const [antOpen, setAntOpen] = useState(false);
  return (
    <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}>
      <AntApp>
        <main className="foundation-page">
          <h1>Orbit theme foundation</h1>
          <nav aria-label="Theme" className="foundation-controls">
            {(['system', 'light', 'dark'] as const).map((value) => (
              <Button key={value} className="foundation-control" aria-pressed={mode === value} onClick={() => setMode(value)}>
                {value[0].toUpperCase() + value.slice(1)}
              </Button>
            ))}
          </nav>
          <p role="status">Theme: {mode} / {resolved}</p>
          <div className="foundation-columns">
            <section aria-label="Orbit foundation" className="foundation-section">
              <h2>Orbit foundation</h2>
              <div className="foundation-controls">
                <Button className="foundation-control foundation-primary">Primary</Button>
                <Button className="foundation-control foundation-primary" disabled>Disabled</Button>
                <Button className="foundation-control foundation-neutral">Neutral</Button>
                <Button className="foundation-control foundation-primary foundation-small">Small</Button>
              </div>
              <OrbitDialog />
            </section>
            <section aria-label="AntD reference" className="foundation-section">
              <h2>AntD reference</h2>
              <div className="foundation-controls">
                <AntButton type="primary">Primary</AntButton>
                <AntButton type="primary" disabled>Disabled</AntButton>
                <AntButton type="text">Neutral</AntButton>
                <AntButton type="primary" size="small">Small</AntButton>
              </div>
              <AntButton onClick={() => setAntOpen(true)}>Open AntD dialog</AntButton>
            </section>
          </div>
          <Modal open={antOpen} title="AntD dialog" onCancel={() => setAntOpen(false)} footer={null} destroyOnHidden>
            <p>The nested Orbit portal shares this modal's focus boundary.</p>
            <OrbitDialog nested />
            <AntButton onClick={() => setAntOpen(false)}>Close AntD dialog</AntButton>
          </Modal>
        </main>
      </AntApp>
    </ConfigProvider>
  );
}

export function FoundationFixture() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  }));
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider><Content /></ThemeProvider>
    </QueryClientProvider>
  );
}
