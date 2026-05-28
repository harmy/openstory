// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import contentCollections from '@content-collections/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';

import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import viteReact from '@vitejs/plugin-react';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Rolldown reorders CJS-to-ESM wrappers: tsyringe checks for
 * Reflect.getMetadata before reflect-metadata's factory runs.
 * This plugin moves the require_Reflect() call before the check.
 */
function reflectMetadataPolyfill(): import('vite').Plugin {
  return {
    name: 'reflect-metadata-polyfill',
    apply: 'build',
    renderChunk(code) {
      if (!code.includes('tsyringe requires a reflect polyfill')) return null;
      const checkPattern =
        /if \(typeof Reflect === "undefined" \|\| !Reflect\.getMetadata\)/;
      const match = checkPattern.exec(code);
      if (!match) return null;
      return (
        code.slice(0, match.index) +
        'require_Reflect();\n' +
        code.slice(match.index)
      );
    },
  };
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
    host: true, // Listen on all interfaces for QStash Docker to reach via host.docker.internal
    allowedHosts: ['localhost', '127.0.0.1', 'host.docker.internal'],
    watch: {
      ignored: [
        '**/e2e/.auth/**',
        '**/e2e/results/**',
        '**/playwright-report/**',
        '**/.wrangler/**',
        '**/test-results/**',
      ],
    },
  },
  preview: {
    port: 3000,
    host: true,
  },
  plugins: [
    contentCollections(),
    isDev && devtools(),
    reflectMetadataPolyfill(),
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart({
      srcDirectory: 'src',
      router: {
        routesDirectory: 'routes',
      },
    }),
    viteReact(),
  ],
  optimizeDeps: {
    // Mermaid itself is excluded because pre-bundling its 74MB / 100+ chunks
    // blocks dev server startup. Its CJS transitive deps must be force-included
    // so Vite wraps them with proper ESM named-export shims.
    exclude: ['mermaid'],
    include: [
      '@braintree/sanitize-url',
      'cytoscape',
      'cytoscape-cose-bilkent',
      'cytoscape-fcose',
      'd3-sankey',
      'dayjs',
      'dayjs/plugin/advancedFormat',
      'dayjs/plugin/customParseFormat',
      'dayjs/plugin/duration',
      'dayjs/plugin/isoWeek',
      'dompurify',
      'katex',
      'roughjs',
      'ts-dedent',
    ],
  },
  ssr: {
    noExternal: [
      '@upstash/realtime',
      '@videojs/react',
      '@tailwindcss/typography',
    ],
  },
});
