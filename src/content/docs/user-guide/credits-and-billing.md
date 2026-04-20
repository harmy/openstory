---
title: Credits & Billing
description: Manage your credit balance, API keys, and billing for AI generation
section: User Guide
order: 10
---

OpenStory uses a credit-based system for AI generation. You can either bring your own API keys (BYOK) or purchase credits.

## Credits Page

Navigate to **Credits** from the user menu. The page has three tabs:

### Balance

View your current credit balance and purchase additional credits via Stripe. After a successful purchase, a confirmation is shown. If you cancel checkout, a cancellation notice appears.

### Transactions

View your transaction history — a log of credit purchases, usage, and adjustments.

### Gift Codes

Redeem gift codes to add credits to your account.

## Billing Gate

When you try to generate content without sufficient credits or API keys, a **billing gate dialog** appears. This dialog explains what's needed and provides options:

- **Add Credits** — Purchase credits via Stripe
- **Add API Keys** — Bring your own keys for direct provider access
- **OpenRouter OAuth** — Connect via OpenRouter for LLM access

The billing gate appears contextually — at first visit (onboarding) and when attempting generation without sufficient resources.

## API Keys (BYOK)

Navigate to **Settings > API Keys** to manage your own provider keys:

### Fal.ai Key

Used for image generation, video/motion generation, and music generation. Fal.ai is the primary provider for all media generation models.

### OpenRouter Key

Used for script analysis (LLM calls). You can either:

- **Enter a key manually** — Paste your OpenRouter API key
- **Connect via OAuth** — One-click OAuth flow that automatically provisions a key

### How BYOK Works

When you provide your own API keys:

- Credits are not consumed for that provider
- You're billed directly by the provider
- Both BYOK and credits can coexist — BYOK is used when a key is available, credits are used otherwise

## Insufficient Credits

If you run out of credits during generation:

- In-progress work continues (workflows are durable)
- New generation requests show an error toast: "Insufficient credits" with an **Add Credits** action button
- The billing gate dialog appears when you try to generate
