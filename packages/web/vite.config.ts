import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev proxies /api (REST + SSE) to the control plane, so the browser stays same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
