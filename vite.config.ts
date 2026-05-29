// vite.config.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import contentCollections from '@content-collections/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig, type Plugin } from 'vite';

import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import viteReact from '@vitejs/plugin-react';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Prints which wrangler.jsonc bindings are local vs REMOTE on dev startup.
 *
 * @cloudflare/vite-plugin used to default `remoteBindings: true`, which would
 * silently route D1 writes to the production database. We disable it at the
 * plugin level (see cloudflare() call below); this banner is the runtime
 * checkpoint — if anyone re-enables remote bindings or flips `remote: true`
 * on D1, the next `bun dev` boot will show it in red on the first screen.
 */
function wranglerBindingsBanner(): Plugin {
  return {
    name: 'wrangler-bindings-banner',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        type Binding = { binding: string; remote?: boolean };
        type WranglerConfig = {
          d1_databases?: Binding[];
          r2_buckets?: Binding[];
          kv_namespaces?: Binding[];
        };

        const raw = readFileSync(
          resolve(import.meta.dirname, 'wrangler.jsonc'),
          'utf-8'
        );
        // Strip line + block comments + trailing commas so JSON.parse accepts it.
        const stripped = raw
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/,(\s*[}\]])/g, '$1');
        const cfg: WranglerConfig = JSON.parse(stripped);

        const rows: Array<[string, string, boolean]> = [];
        for (const b of cfg.d1_databases ?? [])
          rows.push(['D1', b.binding, !!b.remote]);
        for (const b of cfg.r2_buckets ?? [])
          rows.push(['R2', b.binding, !!b.remote]);
        for (const b of cfg.kv_namespaces ?? [])
          rows.push(['KV', b.binding, !!b.remote]);

        const nameWidth = Math.max(...rows.map(([, n]) => n.length), 0);
        const RED = '\x1b[31m';
        const DIM = '\x1b[2m';
        const RESET = '\x1b[0m';

        // process.stdout.write (not console.log) so this stays under the
        // file-wide eslint/no-console rule. Vite plugins run in Node at dev
        // startup; this banner is intentional diagnostic output.
        process.stdout.write('\n  wrangler bindings (default env):\n');
        for (const [kind, name, remote] of rows) {
          const status = remote
            ? `${RED}REMOTE${RESET}  (writes hit real Cloudflare)`
            : `${DIM}local${RESET}   (Miniflare)`;
          process.stdout.write(
            `    ${kind} ${name.padEnd(nameWidth)}  →  ${status}\n`
          );
        }
        if (rows.some(([, , r]) => r)) {
          process.stdout.write(
            `  ${DIM}↑ remote bindings opt-in per-entry in wrangler.jsonc; D1 should always be local in dev.${RESET}\n\n`
          );
        } else {
          process.stdout.write('\n');
        }
      });
    },
  };
}

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
    isDev && wranglerBindingsBanner(),
    reflectMetadataPolyfill(),
    tailwindcss(),
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // remoteBindings is left at its default (true) so per-binding
      // `remote: true` in wrangler.jsonc routes the R2 buckets to real
      // Cloudflare (image-write paths need real R2 so R2_PUBLIC_STORAGE_DOMAIN
      // reads resolve). The default D1 binding uses a placeholder
      // `database_id` (see wrangler.jsonc) so even if cf-plugin auto-promotes
      // it, the request 404s against Cloudflare rather than writing to prod.
      // The startup banner (wranglerBindingsBanner) confirms per-boot.
    }),
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
