---
title: Getting Started
description: Set up OpenStory for local development
section: Developer Guide
order: 1
---

OpenStory is an open-source AI video production platform. This guide walks you through setting up a local development environment.

## Prerequisites

- [Bun](https://bun.com/docs/installation) >= 1.3.0
- [Git](https://git-scm.com)
- [Docker](https://www.docker.com) — for the QStash workflow emulator ([OrbStack](https://orbstack.dev) recommended on macOS)

No external database is required for local development — `bun setup` configures a local SQLite file (`local.db`) automatically.

## Quick Start

```bash
# Clone the repository
git clone https://github.com/openstory-so/openstory.git
cd openstory

# Install dependencies
bun install

# Interactive setup — checks prerequisites, generates BETTER_AUTH_SECRET,
# and configures local SQLite + QStash defaults in .env.local
bun setup
```

## Running the Dev Server

```bash
bun dev
```

This single command runs everything in parallel: database migration and seeding, the dev server, the QStash workflow emulator (Docker), and the Stripe listener.

The app will be available at [http://localhost:3000](http://localhost:3000).

## Environment Variables

`bun setup` writes a working `.env.local` for you. See [`.env.example`](https://github.com/openstory-so/openstory/blob/main/.env.example) for the full list of available environment variables, including optional services like AI keys, storage, and OAuth providers.

## Database

Local development uses a SQLite file (`local.db`) via the [libSQL](https://github.com/tursodatabase/libsql) client and [Drizzle ORM](https://orm.drizzle.team) — no account or remote service required.

```bash
# Generate migrations from schema changes
bun db:generate

# Apply migrations
bun db:migrate

# Open Drizzle Studio
bun db:studio
```

Production deployments use Cloudflare D1 (default) or Turso. See the [Cloudflare deployment guide](/docs/deployment/cloudflare) for details.

## Next Steps

- [Creating Sequences](/docs/user-guide/creating-sequences) — Create your first video sequence
- [Working with Scenes](/docs/user-guide/scenes) — Edit and refine individual scenes
- [AI Models](/docs/user-guide/ai-models) — Complete model reference
- [Deploy to Cloudflare](/docs/deployment/cloudflare) — Production deployment guide
