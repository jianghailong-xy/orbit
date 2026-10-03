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
import { installPaneSlideOnPopState } from './lib/paneTransition';
import { installScrollbarAutohide } from './lib/scrollbarAutohide';
import { ToastViewport } from './components/ToastViewport';

// Arm the access-token auto-refresh as early as possible: if a valid session is already stored,
// schedule a silent refresh just before it expires so an active tab is never bounced to /login.
scheduleProactiveRefresh();

// Arm the phone's list <-> conversation slide for the backs the app doesn't issue itself (browser
// Back, Android's system back, the edge swipe). Before the first render, so it is listening from
// the very first navigation.
installPaneSlideOnPopState();

// The nav and session lists keep their scrollbars hidden until they're scrolled.
installScrollbarAutohide();

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

// Toasts are not AntD's: lib/toast.tsx posts them into one feed and <ToastViewport /> draws it
// (docs/mocks/toast-system), inside the router so a toast that names a session can open it. How
// long one stays is picked by what it asks of you rather than by which component renders it —
// 3s for a confirmation, 6s for a card with an Undo or a diagnostic, and a failure or warning
// stays until it's dismissed (lib/toastFeed.ts `dwellOf`, the same ramp the native clients use).

// Feeds AntD the matching theme for the resolved light/dark mode; custom CSS is
// driven separately via <html data-theme> (see lib/theme).
function ThemedConfig({ children }: { children: React.ReactNode }) {
  const { resolved } = useThemeMode();
  return (
    <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}>
      <AntApp>
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
            <ToastViewport />
          </BrowserRouter>
        </ThemedConfig>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
