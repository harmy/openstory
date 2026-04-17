---
title: Deploy to Cloudflare
description: Deploy OpenStory to Cloudflare Pages with R2 storage
section: Developer Guide
order: 10
---

Cloudflare Pages is the recommended deployment platform for OpenStory, providing edge runtime, R2 storage, and a global CDN.

## Prerequisites

- A [Cloudflare](https://cloudflare.com) account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed
- A configured R2 bucket for media storage
- A [Turso](https://turso.tech) database for production

## Build for Cloudflare

```bash
# Build with Cloudflare target
BUILD_CLOUDFLARE=1 bun run build
```

This uses the Cloudflare Vite plugin instead of the default Nitro/Bun preset.

## Environment Variables

Set these in your Cloudflare Pages dashboard:

| Variable | Description |
|----------|-------------|
| `TURSO_DATABASE_URL` | Production Turso database URL |
| `TURSO_AUTH_TOKEN` | Turso authentication token |
| `R2_BUCKET_NAME` | R2 bucket for media storage |
| `BETTER_AUTH_SECRET` | Secret for authentication |
| `APP_URL` | Your production URL |

## R2 Storage

OpenStory uses Cloudflare R2 for storing generated images and videos. Create a bucket in your Cloudflare dashboard and configure the binding in `wrangler.toml`.

## CI/CD

The repository includes GitHub Actions workflows (`.github/workflows/`) that:

- Auto-deploy on push to `main`
- Create PR preview deployments
- Provision unique Turso databases per PR

## Platform Detection

OpenStory automatically detects the deployment platform:

```typescript
import { getDeploymentPlatform } from '@/lib/utils/environment';

const platform = getDeploymentPlatform();
// Returns: 'cloudflare' | 'vercel' | 'railway' | 'local'
```
