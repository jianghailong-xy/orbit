import { App as AntApp, ConfigProvider } from 'antd';
import 'antd/dist/reset.css';
import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { BootGate } from './components/BootGate';
import { lightTheme, darkTheme } from './theme';
import { ThemeProvider, useThemeMode } from './lib/theme';
import { scheduleProactiveRefresh } from './api';

// Arm the access-token auto-refresh as early as possible: if a valid session is already stored,
// schedule a silent refresh just before it expires so an active tab is never bounced to /login.
scheduleProactiveRefresh();

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

// Both toast surfaces (message + notification) hang off the viewport's top-right corner, so
// they share one origin — index.css owns the offset for each (AntD's message has no placement
// option, so its full-width holder is right-aligned there too).
//
// Two dwell times across the app, picked by how much there is to read rather than by which
// component happens to render it: 4s for a one-line confirmation (this layer, and the native
// clients' status line), 8s for a card with a headline + session + optional detail, or one
// carrying an Undo (the lifecycle notifications, and the native undo bar). Warnings and errors
// are the third case — they don't leave on their own at all. AntD's Message default is 3s.

// Feeds AntD the matching theme for the resolved light/dark mode; custom CSS is
// driven separately via <html data-theme> (see lib/theme).
function ThemedConfig({ children }: { children: React.ReactNode }) {
  const { resolved } = useThemeMode();
  return (
    <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}>
      <AntApp message={{ duration: 4 }} notification={{ placement: 'topRight', stack: false }}>
        {children}
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ThemedConfig>
          <BrowserRouter>
            <BootGate>
              <App />
            </BootGate>
          </BrowserRouter>
        </ThemedConfig>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
