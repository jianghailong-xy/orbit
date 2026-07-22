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

// Feeds AntD the matching theme for the resolved light/dark mode; custom CSS is
// driven separately via <html data-theme> (see lib/theme).
function ThemedConfig({ children }: { children: React.ReactNode }) {
  const { resolved } = useThemeMode();
  return (
    <ConfigProvider theme={resolved === 'dark' ? darkTheme : lightTheme}>
      <AntApp>{children}</AntApp>
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
