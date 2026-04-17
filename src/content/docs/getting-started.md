---
title: Getting Started
description: Set up OpenStory for local development
section: Developer Guide
order: 1
---

OpenStory is an open-source AI video production platform. This guide walks you through setting up a local development environment.

## Prerequisites

- [Bun](https://bun.sh) (v1.2+)
- [Git](https://git-scm.com)
- A [Turso](https://turso.tech) account (for the database)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/openstory-so/openstory.git
cd openstory

# Install dependencies
bun install

# Auto-configure local dev environment
bun setup

# Set up the database
bun db:setup
```

## Running the Dev Server

OpenStory requires two terminals during development:

**Terminal 1 — Async job processing:**

```bash
bun qstash:dev
```

**Terminal 2 — Dev server:**

```bash
bun dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## Environment Variables

Run `bun setup` to automatically configure your local `.env` file. See `.env.example` for the full list of available environment variables.

## Database

OpenStory uses [Turso](https://turso.tech) (libSQL/SQLite) with [Drizzle ORM](https://orm.drizzle.team).

```bash
# Generate migrations from schema changes
bun db:generate

# Apply migrations
bun db:migrate
```

## Next Steps

- [Deploy to Cloudflare](/docs/deployment/cloudflare) — Production deployment guide
