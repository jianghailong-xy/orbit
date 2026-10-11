import { useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useThemeMode } from '../../../lib/theme';
import { AppRoot } from '../AppRoot';
import './FoundationFixture.css';

// Private browser fixture: this is not the public Button or Dialog contract.
function OrbitDialog() {
  return (
    <div>
      <Dialog.Root>
        <Dialog.Trigger className="foundation-control">Open Orbit dialog</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="foundation-backdrop" />
          <Dialog.Viewport className="foundation-dialog-viewport">
            <Dialog.Popup className="foundation-dialog">
              <Dialog.Title className="foundation-dialog-title">Orbit dialog</Dialog.Title>
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
  return (
    // The app's root (AppRoot, as main.tsx draws it).
    <AppRoot>
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
        </div>
      </main>
    </AppRoot>
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
