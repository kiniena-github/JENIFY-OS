import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API target is configurable so a second isolated stack (e.g. the demo
// environment) can serve the same build against a different backend.
const API = process.env.FACTORYOS_API ?? 'http://127.0.0.1:3001';
const proxy = {
  '/api': { target: API, changeOrigin: false },
  '/branding': { target: API, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: {
    port: 4173,
    proxy,
    // temporary HTTPS tunnels (e.g. *.trycloudflare.com) present a foreign Host
    allowedHosts: true,
  },
});
