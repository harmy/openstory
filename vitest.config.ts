import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Standalone — does NOT extend vite.config.ts. Unit tests run in Node and
// only need path-alias resolution + the React transform for .tsx component
// tests. App-runtime plugins (Cloudflare Vite plugin, content-collections,
// tanstack-start, tailwind, devtools) belong to `vite dev` / `vite build`
// only; pulling them in here breaks vitest (cf-plugin rejects vitest's
// SSR externals) and slows test boot to no benefit.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [viteReact()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
