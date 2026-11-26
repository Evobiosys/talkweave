// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  root: 'app',
  plugins: [svelte()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8990',
        changeOrigin: true,
        // The server's Origin guard only knows its own origin; the dev server
        // is a same-origin front for the browser, so it forwards no Origin.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'));
        }
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
