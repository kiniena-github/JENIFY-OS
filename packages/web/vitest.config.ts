import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Frontend test harness (W1-A7, Founder-approved mobile-viewport regression).
// Deliberately lightweight: vitest + jsdom + @testing-library/react — all local,
// no browser/Playwright download, no network. jsdom has NO layout engine, so
// tests assert on roles/classnames/text, never pixel geometry.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // components under test do not import styles.css; skip CSS processing
    css: false,
    clearMocks: true,
  },
});
