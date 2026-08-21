// AntD v5 paints its click ripple (and its static message/notification/Modal surfaces) through
// ReactDOM's legacy `render`, which React 19 removed — without this patch those calls silently
// no-op and buttons stop rippling. Must be imported before antd. Drop it with the AntD 6 upgrade,
// which renders through React 19 directly.
import '@ant-design/v5-patch-for-react-19';
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
// Two dwell times across the app, picked by what the toast asks of you rather than by which
// component happens to render it: 4s for a one-line confirmation (this layer, and the native
// clients' bare toast), 6s for a card — there's a headline, a session and sometimes a diagnostic
// to take in, often an Undo to decide on, and that's the window the native clients already give
// that decision. Warnings and errors are the third case: they don't leave on their own at all.
// AntD's Message default is 3s.

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
