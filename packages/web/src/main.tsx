import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PWA foundation: register the service worker only for production builds so
// dev hot-reload is never affected.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell is best-effort; the app works without it */
    });
  });
}
