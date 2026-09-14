import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // In dev, Vite runs on its own port (5173) - this proxy makes
      // /api/* calls from the browser transparently reach the Express
      // backend, so the frontend code never needs to know/care about
      // ports or CORS, matching how Caddy will do the same thing in
      // production (both under one origin).
      '/api': {
        target: 'http://localhost:5051',
        changeOrigin: true,
      },
    },
  },
});
