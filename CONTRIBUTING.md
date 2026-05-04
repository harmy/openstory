# Contributing to OpenStory

Thanks for your interest in contributing! OpenStory is MIT-licensed and we welcome contributions of all kinds — bug reports, feature requests, documentation improvements, and code.

For detailed architecture documentation, see [CLAUDE.md](CLAUDE.md).

## Getting Started

### Prerequisites

- **Bun** >= 1.3.0 — [install](https://bun.com/docs/installation)
- **Docker** — for the QStash workflow emulator ([OrbStack](https://orbstack.dev) recommended on macOS)

### Setup

```bash
# Fork and clone
gh repo fork openstory-so/openstory --clone
cd openstory

# Install dependencies and configure environment
bun install
bun setup        # Interactive — checks prerequisites, generates secrets, configures services
bun dev          # Starts dev server, QStash emulator, and Stripe listener
```

`bun setup` handles everything: it checks prerequisites, generates `BETTER_AUTH_SECRET`, sets up local SQLite + QStash defaults, and walks you through optional service configuration (AI keys, storage, OAuth, etc.).

`bun dev` runs DB migration, seeding, dev server, QStash (Docker), and Stripe listener in parallel.

Open [http://localhost:3000](http://localhost:3000) — you should see the app running.

## Development Workflow

### Branch Naming

Branch names **must** follow the pattern `<issue-number>-feature-name`:

```
393-improve-readme
142-fix-frame-export
57-add-motion-controls
```

Lefthook automatically tags commits with the issue number extracted from the branch name.

### Finding Work

- Look for issues labeled [`good first issue`](https://github.com/openstory-so/openstory/labels/good%20first%20issue) or [`help wanted`](https://github.com/openstory-so/openstory/labels/help%20wanted)
- For larger changes, open an issue first to discuss the approach

### Daily Development

`bun dev` runs everything in parallel: DB migration, dev server, QStash (Docker), and Stripe listener.

Key commands:

| Command         | Description                                                     |
| --------------- | --------------------------------------------------------------- |
| `bun dev`       | Start all dev services                                          |
| `bun run build` | Build for production (**not** `bun build` — that's the bundler) |
| `bun typecheck` | Type-check with tsgo                                            |
| `bun test`      | Run unit tests                                                  |
| `bun test:e2e`  | Run Playwright end-to-end tests                                 |

## Code Quality

### Automated on Commit

Lefthook runs on every commit:

- **oxlint** — linting (type-aware)
- **oxfmt** — formatting
- **tsgo** — type checking

on staged files. If the hooks fail, fix the issues before committing.

### Manual Checks

```bash
bun lint          # Lint the codebase
bun lint:fix      # Lint and auto-fix
bun format        # Format with oxfmt
bun format:check  # Check formatting without writing
bun typecheck     # Type-check with tsgo
bun dead-code     # Find unused exports with Knip
```

### CI

GitHub Actions runs the full quality gate on every pull request: lint, format, typecheck, unit tests, and E2E tests. All checks must pass before merging.

## Testing

### Unit Tests

```bash
bun test              # Run all tests
bun test:watch        # Watch mode
bun test:coverage     # With coverage report
```

- Framework: `bun:test`
- Location: `__tests__/` directories alongside routes, or `.test.ts` next to modules
- Focus on business logic — not React components

### End-to-End Tests

```bash
bun test:e2e          # Run Playwright tests (hermetic — workflows skipped)
bun test:e2e:ui       # Interactive Playwright UI
bun test:e2e:full     # Full pipeline: real workflows, qstash, fal+LLM via aimock fixtures
```

- Location: `e2e/tests/`
- Uses Playwright with a dedicated test database
- LLM (OpenRouter) and fal.ai traffic is served by [aimock](https://github.com/CopilotKit/aimock) on port 4010 — fal.ai goes through a custom handler mounted at `/fal`

#### Refreshing recorded e2e fixtures

The full-pipeline test (`e2e/tests/full-sequence.spec.ts`) replays AI responses from `e2e/fixtures/recorded/`. To capture or refresh them:

```bash
# 1. Start qstash locally
bun qstash:dev

# 2. With real keys in .env.local (FAL_KEY, OPENROUTER_KEY), run the recorder
bun scripts/record-e2e-fixtures.ts
```

The recorder retries the spec up to `E2E_RECORD_PASSES` times (default 8). Each pass records the AI call that broke the previous one — aimock buffers responses while recording, which breaks streaming RPCs, but once a fixture exists on disk subsequent runs replay it as a proper stream. Tracked upstream in [CopilotKit/aimock#152](https://github.com/CopilotKit/aimock/issues/152).

Commit the generated fixtures alongside any code change that alters AI prompts or model selection.

> See the [Testing](CLAUDE.md#testing) section in CLAUDE.md for mock patterns and database testing conventions.

## Database Changes

1. Modify schema files in `src/lib/db/schema/`
2. Generate migration: `bun db:generate`
3. Apply migration: `bun db:migrate`

**Important:**

- **Never** write migration SQL manually — always use Drizzle Kit
- Use **ULID** primary keys (not UUID)
- Types are auto-inferred from the schema by Drizzle
- Database access is only allowed in server handlers (never in components)

## Code Conventions

A brief summary — see [CLAUDE.md](CLAUDE.md) for full patterns with examples.

### TypeScript

- Use `type` instead of `interface`
- No `any` or `unknown` — keep proper types
- Throw errors instead of returning success booleans

### Files

- kebab-case filenames (e.g., `frame-editor.tsx`)
- Named exports (no default exports)

### React

- **Data fetching:** TanStack Query + Suspense (no `useState` + `useEffect` for data)
- **Styling:** shadcn/ui base components + Tailwind for layout only (flex, gap, grid)
- **Loading states:** inline `<Skeleton />` fallbacks (no separate skeleton components)
- **Complex state:** `useReducer` with vanilla TS reducer (not multiple `useState`)
- **Forms:** TanStack Query mutations + Zod validation

### Server

- DB access only in server handlers — never in components
- Follow the [server handler pattern](CLAUDE.md#server-handler-pattern) in CLAUDE.md
- Trigger workflows via `qstash.publishJSON()` — never direct `fetch()` calls

## Pull Request Process

1. **Branch from `main`** using the `<issue>-feature` naming convention
2. **Run quality checks locally** before pushing:
   ```bash
   bun lint && bun format:check && bun typecheck && bun test
   ```
3. **Push and create a PR** — fill out the PR template completely
4. **Include `Closes #<issue>`** in the PR description so the issue auto-closes on merge
5. **CI must pass** — lint, format, typecheck, tests, and E2E
6. **PR previews** — Cloudflare automatically deploys a preview with a dedicated database

## Reporting Issues

### Bug Reports

Use the [bug report template](https://github.com/openstory-so/openstory/issues/new?template=bug_report.yml) and include:

- Steps to reproduce
- Expected vs actual behavior
- Browser/OS/Bun version

### Feature Requests

Use the [feature request template](https://github.com/openstory-so/openstory/issues/new?template=feature_request.yml):

- Describe the problem before proposing a solution
- Include use cases and context

### Large Changes

For significant architectural changes or new features, **open an issue first** to discuss the approach before writing code. This avoids wasted effort if the direction doesn't align with the project's goals.
