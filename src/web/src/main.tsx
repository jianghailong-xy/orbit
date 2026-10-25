// The first page's stylesheet is these modules' CSS in the order they are first imported (vite.config.ts).
// The app root's text and links come first, where the replaced library injected them. The overlays', the
// review cards' and highlight.js's styles come ahead of the reset and index.css, where production builds
// have linked them so far (a chunk the entry shared with the lazy session export), so the page rules keep
// the same-weight ties with them that they have been winning. Every other Orbit component's CSS follows
// index.css.
import './components/ui/root.css';
import './components/ui/Overlay.css';
import './components/ReviewCard.css';
import 'highlight.js/styles/github.css';
import './components/ui/reset.css';
import './index.css';
import './components/ui/foundation.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { BootGate } from './components/BootGate';
import { ThemeProvider } from './lib/theme';
import { scheduleProactiveRefresh } from './api';
import { installPaneSlideOnPopState } from './lib/paneTransition';
import { installScrollbarAutohide } from './lib/scrollbarAutohide';
import { ToastViewport } from './components/ToastViewport';
import { AppRoot } from './components/ui/AppRoot';

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

// lib/toast.tsx posts toasts into one feed and <ToastViewport /> draws it (docs/mocks/toast-system),
// inside the router so a toast that names a session can open it. How long one stays is picked by
// what it asks of you rather than by which component renders it — 3s for a confirmation, 6s for a
// card with an Undo or a diagnostic, and a failure or warning stays until it's dismissed
// (lib/toastFeed.ts `dwellOf`, the same ramp the native clients use).

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {/* The text and links every page inherits (components/ui/root.css). The theme is <html data-theme>. */}
        <AppRoot>
          <BrowserRouter>
            <BootGate>
              <App />
            </BootGate>
            <ToastViewport />
          </BrowserRouter>
        </AppRoot>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
