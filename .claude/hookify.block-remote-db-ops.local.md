---
name: block-remote-db-ops
enabled: true
event: bash
action: block
pattern: db:(migrate|push|studio|seed):d1|setup:(prd|stg|deploy)|drizzle\.config\.d1\.ts
---

🚫 **Remote database operation blocked!**

You attempted a command that mutates or connects to the **remote Cloudflare D1 database** or a remote deploy target. These commands skip local sandboxing and can destroy production data.

**Safe local equivalents:**

- `bun db:migrate:local` — apply migrations to `local.db`
- `bun db:push:local` — push schema to `local.db`
- `bun db:studio:local` — open Drizzle Studio against `local.db`
- `bun db:seed:local` — seed `local.db`
- `bun db:setup:local` — migrate + seed `local.db` end-to-end
- `wrangler d1 execute <db> --local …` — run SQL against the local D1 binding

**To intentionally hit a remote database:**

1. Ask the human to run the command themselves, OR
2. Have them set `enabled: false` in `.claude/hookify.block-remote-db-ops.local.md` for a single deploy, then re-enable it immediately afterwards.

**Why this is blocked:**

- `db:*:turso` / `db:*:d1` use `drizzle.config.turso.ts` / `drizzle.config.d1.ts` and write to live infra
- bare `db:seed` defaults to Turso via `TURSO_DATABASE_URL`
- `setup:prd|stg|deploy` provisions / mutates remote Cloudflare + Turso resources
- `wrangler d1 execute` without `--local` runs against the deployed D1 database
