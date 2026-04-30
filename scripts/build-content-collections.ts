/**
 * Pre-builds @content-collections so `.content-collections/generated/` exists
 * before any Vite dev server starts.
 *
 * The vite plugin builds in `buildStart`, but in some CI runs that hook is
 * delayed past the point where Nitro/TanStack Start begins loading the SSR
 * module graph. Routes under `src/routes/docs/` import from `content-collections`,
 * so when the alias target is empty Vite stalls indefinitely waiting for the
 * module — eventually tripping playwright's webServer timeout.
 *
 * Running the build explicitly in `test:e2e:setup` removes that race.
 */
import { createBuilder } from '@content-collections/core';
import { resolve } from 'node:path';

const configPath = resolve(process.cwd(), 'content-collections.ts');
const builder = await createBuilder(configPath);
await builder.build();
console.log('[content-collections] Built successfully');
